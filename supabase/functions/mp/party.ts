// -----------------------------------------------------------------------------
// Pickup: in-person co-op. A host starts a session and shows a join code; friends
// join on their own phones and everyone contributes toward a shared target.
//
// Deliberately unlike every other mode here:
//   - No accounts. Any auth step in a bar kills this.
//   - No strikes. Eight excited people guess wrong constantly; three strikes
//     would end the party in twenty seconds and punish the group for one person.
//     Pressure comes from the timer; misses are a celebratory stat.
//   - No per-person ranking. Contribution counts in the recap are fun; a live
//     leaderboard makes the guy who knows the most win and everyone else stop
//     shouting.
//   - No read-modify-write. mp_party_answers' primary key (session_id,
//     player_key) is the dedupe, so Postgres arbitrates concurrent submissions.
// -----------------------------------------------------------------------------
import {
  db, ok, err, authedUserId, normalize, randomToken,
  matchPoolGuess, rosterReveal, RARITY_LABEL,
  consensusFor, scoreBoard, drawSet,
} from "./shared.ts";
import type { PoolEntry, TierItem } from "./shared.ts";
import { makeCrewCode } from "./crews.ts";
// Pickup builds its own challenges from the same filter vocabulary Name It uses.
// games.ts does not import party.ts, so this direction is safe.
import { buildChallengeFilters, composeFilterSubject } from "./games.ts";

const MAX_LABEL = 24;
const PG_UNIQUE_VIOLATION = "23505";

// ---------------------------------------------------------------------------
// Rounds. A session used to be one prompt: five minutes of shouting, a recap,
// and "Run it back" with the same prompt — one game replayed. A `night` is three
// rounds of different shapes ending in one combined recap.
//
// Each round's payoff is a different KIND of recognition on purpose — a team
// number, a joke title, a survivor — so different people win different things.
// There is deliberately no cross-round points total; a combined leaderboard
// would re-introduce exactly what the no-live-ranking rule above excludes.
// ---------------------------------------------------------------------------
const RAPID_S = 120;          // a night's opening round; short enough to keep the energy
const TURN_S = 15;            // sudden death, per turn
const CONSENSUS_ITEMS = 5;
// Round 2 is a 1-to-5 ORDERING, not a tier bucketing. Five names into six tier
// buckets mostly produces ties and a shrug; forcing a strict order makes everyone
// commit, and "you had him 2nd, the room had him 5th" is a better argument than
// "you both said B".
//
// It still rides on consensusFor/scoreBoard unchanged, because those take the
// label vocabulary as a parameter and only ever use its INDEX — so ["1".."5"]
// behaves exactly like a tier ladder with index 0 = best.
const CONSENSUS_RANKS = ["1", "2", "3", "4", "5"];
const OU_ITEMS = 5;               // questions in the Who's Got More round
const OU_SIDES = ["a", "b"];      // the vote vocabulary, same slot as `tiers`
const ROUND_LABEL: Record<string, string> = {
  rapid: "Rapid Fire", consensus: "Guess the Room",
  overunder: "Who's Got More", sudden: "Sudden Death",
};
// Rounds where a member submits one board of choices. Both use
// mp_party_round_boards and therefore the same autosave, the same submitted_at
// ready signal and the same primary-key dedupe.
const BOARD_ROUNDS = new Set(["consensus", "overunder"]);

async function uniquePartyCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const c = makeCrewCode();
    const { data } = await db.from("mp_party_sessions").select("id").eq("code", c).maybeSingle();
    if (!data) return c;
  }
  return makeCrewCode();
}

function cleanLabel(v: unknown, fallback = "Player"): string {
  return (String(v ?? "").trim() || fallback).slice(0, MAX_LABEL);
}

// ---------------------------------------------------------------------------
// Who's who. Everyone in the room used to render behind the same 🏀, which made
// the lobby, the shared board and the sudden-death seat rail a wall of identical
// icons — you had to read four names to find yourself. One emoji each fixes that
// at a glance, and it survives two people picking the same label.
//
// DERIVED from join order, not stored. joined_at never changes, so the value is
// stable for the life of the session; a column would be a second copy of a fact
// the row already carries, and assigning it on insert would race between two
// phones joining at once. Every members query orders by (joined_at, id) — the id
// tiebreak matters, because equal timestamps would otherwise let two members
// swap emoji between polls.
//
// Distinct up to 20 people, which is well past the point where a room can hear
// itself. Beyond that it wraps, and two people share — cosmetic, and preferable
// to reaching for symbols nobody can tell apart at 14px.
const PARTY_EMOJI = [
  "🦊", "🐻", "🐼", "🦁", "🐯", "🐸", "🐙", "🦈", "🐝", "🦄",
  "🐺", "🦉", "🐨", "🦅", "🐢", "🦖", "🐬", "🦋", "🐧", "🦩",
];
const MEMBER_ORDER = { ascending: true } as const;

function withEmoji<T extends { id: string }>(rows: T[] | null | undefined) {
  return (rows ?? []).map((m, i) => ({ ...m, emoji: PARTY_EMOJI[i % PARTY_EMOJI.length] }));
}

// The one place members are read, so join order (and therefore the emoji) can
// never disagree between two callers.
async function loadMembers(sessionId: string) {
  const { data } = await db.from("mp_party_members").select("id, label")
    .eq("session_id", sessionId)
    .order("joined_at", MEMBER_ORDER).order("id", MEMBER_ORDER);
  return withEmoji(data);
}

// member_id -> emoji, for the rows that denormalise a label rather than joining.
async function emojiMap(sessionId: string): Promise<Map<string, string>> {
  return new Map((await loadMembers(sessionId)).map((m) => [m.id, m.emoji]));
}

// Sessions end on their own so a host whose phone locks can't strand the room.
// Called lazily from state/guess rather than by a scheduler.
async function autoEndIfExpired(session: any) {
  if (session.status !== "live" || !session.ends_at) return session;
  if (new Date(session.ends_at).getTime() > Date.now()) return session;
  const { data } = await db.from("mp_party_sessions")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", session.id).eq("status", "live").select("*").single();
  // Only a classic session has a session-level clock, so this only ever closes
  // the single rapid round — a night's rounds carry their own and end themselves.
  await endOpenRounds(session.id);
  return data ?? { ...session, status: "ended" };
}

function secondsLeft(session: any): number | null {
  if (!session.ends_at) return null;
  return Math.max(0, Math.round((new Date(session.ends_at).getTime() - Date.now()) / 1000));
}

function publicSession(s: any) {
  return {
    id: s.id, code: s.code, share_token: s.share_token, prompt: s.prompt,
    target: s.target, status: s.status, misses: s.misses,
    time_limit_s: s.time_limit_s, seconds_left: secondsLeft(s),
    format: s.format ?? "classic",
  };
}

// ---------------------------------------------------------------------------
// Round plumbing
// ---------------------------------------------------------------------------
async function loadRounds(sessionId: string) {
  const { data } = await db.from("mp_party_rounds").select("*")
    .eq("session_id", sessionId).order("idx", { ascending: true });
  return data ?? [];
}

// Which round the room is looking at. Derived from the statuses rather than
// stored on the session: a current_round column would be a second copy of a fact
// these rows already hold, free to drift.
//   live     -> play it
//   pending  -> we are at intermission, showing `ended`'s payoff
//   neither  -> the night is over
function roundPhase(rounds: any[]) {
  return {
    live: rounds.find((r) => r.status === "live") ?? null,
    pending: rounds.find((r) => r.status === "pending") ?? null,
    ended: [...rounds].reverse().find((r) => r.status === "ended") ?? null,
  };
}

function turnSecondsLeft(r: any): number | null {
  if (!r?.turn_expires_at) return null;
  return Math.max(0, Math.round((new Date(r.turn_expires_at).getTime() - Date.now()) / 1000));
}

function roundSecondsLeft(r: any): number | null {
  if (!r?.ends_at) return null;
  // A round that filled its board ends before its clock does, and its ends_at is
  // then still in the future — reporting it would put a ticking countdown on the
  // intermission screen of a round that is already over.
  if (r.status === "ended") return 0;
  return Math.max(0, Math.round((new Date(r.ends_at).getTime() - Date.now()) / 1000));
}

// Round 2's item_set is safe to expose — the five names to rank ARE the round,
// and there is no answer to leak.
//
// ⚠️ Round 3's is NOT. Each question carries both players' real numbers and
// which side is right, so it goes out through stripAnswers() until the round has
// ended. A "don't render it yet" client-side rule would be no rule at all.
function itemSetFor(r: any) {
  if (r.kind === "consensus") return r.item_set ?? [];
  if (r.kind === "overunder") {
    const items = (r.item_set ?? []) as OuQuestion[];
    return r.status === "ended" ? items : stripAnswers(items);
  }
  return null;
}

function publicRound(r: any, extra: Record<string, unknown> = {}) {
  if (!r) return null;
  return {
    id: r.id, idx: r.idx, kind: r.kind, label: ROUND_LABEL[r.kind] ?? r.kind,
    status: r.status, prompt: r.prompt, target: r.target,
    item_set: itemSetFor(r),
    tiers: r.tiers ?? null,
    time_limit_s: r.time_limit_s, seconds_left: roundSecondsLeft(r),
    turn_member_id: r.turn_member_id, turn_seq: r.turn_seq,
    turn_seconds_left: turnSecondsLeft(r),
    ...extra,
  };
}

// A round's own clock running out ends the ROUND. For a night that means
// intermission; the session ends only once every round has. Mirrors
// autoEndIfExpired above — lazy, called from state/guess, never scheduled, so a
// host's phone locking still cannot strand the room.
async function autoEndRoundIfExpired(round: any) {
  if (!round || round.status !== "live" || !round.ends_at) return round;
  if (new Date(round.ends_at).getTime() > Date.now()) return round;
  const { data } = await db.from("mp_party_rounds")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", round.id).eq("status", "live").select("*").single();
  return data ?? { ...round, status: "ended" };
}

// A stalled turn is eliminated by whoever polls next, not by the host's device.
// The compare-and-swap lives in SQL (mp_party_advance_turn, guarded on
// turn_seq), so several devices noticing the same expiry at the same instant
// produce exactly one elimination.
async function autoAdvanceTurn(round: any) {
  if (!round || round.kind !== "sudden" || round.status !== "live") return round;
  if (!round.turn_expires_at) return round;
  if (new Date(round.turn_expires_at).getTime() > Date.now()) return round;
  await db.rpc("mp_party_advance_turn", {
    p_round: round.id, p_expect_seq: round.turn_seq, p_turn_s: TURN_S, p_timeout: true,
  });
  const { data } = await db.from("mp_party_rounds").select("*").eq("id", round.id).maybeSingle();
  return data ?? round;
}

// Closing the last round closes the session. Idempotent, and `neq` makes a race
// between two pollers harmless.
async function syncSessionEnd(session: any, rounds: any[]) {
  if (session.status === "ended") return session;
  if (!rounds.length || rounds.some((r) => r.status !== "ended")) return session;
  const { data } = await db.from("mp_party_sessions")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", session.id).neq("status", "ended").select("*").single();
  return data ?? { ...session, status: "ended" };
}

// The session ending (its clock, or the rapid target being hit in a classic
// session) has to close any round still open, or the recap would sit behind an
// intermission nobody can advance past.
async function endOpenRounds(sessionId: string) {
  await db.from("mp_party_rounds")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("session_id", sessionId).neq("status", "ended");
}

// Round 2 argues about five players THE ROOM ACTUALLY NAMED in round 1. That is
// what makes a night feel like one game rather than three unrelated ones, and it
// guarantees the five are names this particular room has proved it knows. Drawn
// from the recognisable end of what they said, so it is a debate and not a
// memory test. Tops up from the pool only if the room named fewer than five.
async function drawConsensusItems(session: any): Promise<TierItem[]> {
  const pool = (Array.isArray(session.answers_snapshot) ? session.answers_snapshot : []) as PoolEntry[];
  const byKey = new Map(pool.map((p) => [p.player_key, p]));
  const { data: named } = await db.from("mp_party_answers")
    .select("player_key, display_name").eq("session_id", session.id);

  const namedKeys = new Set((named ?? []).map((a) => a.player_key));
  const fame = (p: any) => Number(p?.rarity_score ?? 0);
  const namedEntries = (named ?? [])
    .map((a) => byKey.get(a.player_key) ?? { player_key: a.player_key, display_name: a.display_name, rarity_score: 0 } as any)
    .sort((a, b) => fame(b) - fame(a));

  const out: TierItem[] = [];
  const seen = new Set<string>();
  // 37 genuine homonyms exist in the player data, so two entries can normalise to
  // one key. Assignments are keyed on it, so a collision would make two chips the
  // same chip — skip and top up instead.
  const push = (p: any) => {
    const key = normalize(p.display_name);
    if (!key || seen.has(key)) return;
    seen.add(key); out.push({ key, label: p.display_name });
  };
  for (const p of drawSet(namedEntries.slice(0, 10), CONSENSUS_ITEMS)) push(p);
  if (out.length < CONSENSUS_ITEMS) {
    const rest = pool.filter((p) => !namedKeys.has(p.player_key)).sort((a, b) => fame(b) - fame(a));
    for (const p of rest) { if (out.length >= CONSENSUS_ITEMS) break; push(p); }
  }
  return out;
}

// Round 2's reveal. consensusFor and scoreBoard are pure — boards arrive as a
// parameter and neither queries — which is the whole reason this round needs no
// mp_tier_topics row: the room's opinions can never move a public theme's
// consensus, and the live demo boards can never move the room's score.
function consensusReveal(round: any, boards: any[], emoji?: Map<string, string>) {
  const items = (round.item_set ?? []) as TierItem[];
  const tiers = (round.tiers ?? CONSENSUS_RANKS) as string[];
  // Two boards is the floor for "the room" to mean anything at all. Below it the
  // client shows the boards side by side rather than inventing a consensus.
  const need = 2;
  if (boards.length < need) {
    return { unlocked: false, have: boards.length, need, consensus: [], scores: [], order: [], divisive: null };
  }
  const consensus = consensusFor(items, boards, tiers);
  const idx = new Map(tiers.map((t, i) => [t, i]));

  // THE ROOM'S ORDER. Mean position, not the modal one: modal ranks are picked
  // per player independently, so they can easily put two people 2nd and nobody
  // 3rd — not an ordering at all. The mean always sorts into a real 1..n list,
  // which is the whole point of making this round a ranking.
  const meanOf = (key: string) => {
    let sum = 0, n = 0;
    for (const b of boards) {
      const v = (b.assignments || {})[key];
      if (v != null && idx.has(v)) { sum += idx.get(v)!; n++; }
    }
    return n ? sum / n : Infinity;
  };
  const order = items.map((it) => ({ key: it.key, label: it.label, mean: meanOf(it.key) }))
    .sort((a, b) => a.mean - b.mean || a.label.localeCompare(b.label))
    // mean goes out 1-BASED, like every other rank in this payload. It is computed
    // from label indexes, which are 0-based; shipping that raw would leave the
    // client adding one and the wire format meaning something other than it says.
    .map((r, i) => ({ ...r, rank: i + 1, mean: r.mean === Infinity ? null : Math.round((r.mean + 1) * 100) / 100 }));

  // Score against that order rather than against the modal, so "matched 3/5"
  // means three players put exactly where the room put them.
  const consensusRank = new Map(order.map((o) => [o.key, tiers[o.rank - 1] ?? null]));
  const versusOrder = consensus.map((c) => ({ ...c, modal_tier: consensusRank.get(c.key) ?? null }));
  const scores = boards.map((b) => {
    const s = scoreBoard(b.assignments, versusOrder, tiers);
    return {
      member_id: b.member_id, label: b.member_label,
      // Their identity in the room. Distinct from `emoji` below, which is the
      // spice BAND (🚨/🌶️/🧊) — two different things that both happen to be a
      // glyph next to a name, so they get two different keys.
      member_emoji: emoji?.get(b.member_id) ?? null,
      ...(s ?? { matched: 0, rated: 0, spice: 0, emoji: "🤷", title: "Didn't rank" }),
    };
  }).sort((a, b) => b.spice - a.spice);   // spiciest first — the Menace leads the reveal

  // Widest disagreement: the biggest gap between where two people put the same
  // player. On a 1..5 ordering that reads better than a distribution spread —
  // "you had him 1st and 5th" is the argument worth surfacing.
  let divisive: { label: string; spread: number; low: string | null; high: string | null } | null = null;
  for (const it of items) {
    let lo = Infinity, hi = -Infinity;
    for (const b of boards) {
      const v = (b.assignments || {})[it.key];
      if (v == null || !idx.has(v)) continue;
      lo = Math.min(lo, idx.get(v)!); hi = Math.max(hi, idx.get(v)!);
    }
    if (hi < 0) continue;
    const spread = hi - lo;
    if (!divisive || spread > divisive.spread) {
      divisive = { label: it.label, spread, low: tiers[lo] ?? null, high: tiers[hi] ?? null };
    }
  }
  return { unlocked: true, have: boards.length, need, consensus, scores, order, divisive };
}

// ---------------------------------------------------------------------------
// "Who's Got More" — the one round with a right answer.
//
// Every other round pays off in opinion, which means nobody can be told they
// are wrong. This one can, and that is the point: a fact both people were sure
// about is a better argument than a fact only one of them had.
//
// The facts come from mp_player_facets, which already holds every one of these
// per player — so a question is a join, not a stats pipeline.
// ---------------------------------------------------------------------------
type OuStat = { key: string; col: string; ask: string; fmt: (n: number) => string };
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const OU_STATS: OuStat[] = [
  { key: "rings", col: "rings", ask: "more championship rings", fmt: (n) => plural(n, "ring") },
  { key: "allstar", col: "allstar_n", ask: "more All-Star selections", fmt: (n) => plural(n, "All-Star") },
  { key: "points", col: "career_points", ask: "more career points", fmt: (n) => `${Math.round(n).toLocaleString("en-US")} pts` },
  { key: "allnba", col: "allnba_n", ask: "more All-NBA selections", fmt: (n) => plural(n, "All-NBA team") },
  { key: "alldef", col: "alldef_n", ask: "more All-Defensive selections", fmt: (n) => plural(n, "All-Defense team") },
  { key: "mvp", col: "mvp_n", ask: "more MVPs", fmt: (n) => plural(n, "MVP") },
  { key: "seasons", col: "seasons_n", ask: "more seasons in the league", fmt: (n) => plural(n, "season") },
  { key: "games", col: "games_played", ask: "more games played", fmt: (n) => `${n.toLocaleString("en-US")} games` },
];

type OuQuestion = {
  key: string; stat: string; ask: string;
  a: { key: string; label: string; v: number; shown: string };
  b: { key: string; label: string; v: number; shown: string };
  answer: "a" | "b";
};

// ⚠️ item_set holds the answer. Never hand a live round's questions to a client
// without running them through this.
function stripAnswers(items: OuQuestion[]) {
  return items.map((q) => ({
    key: q.key, stat: q.stat, ask: q.ask,
    a: { key: q.a.key, label: q.a.label },
    b: { key: q.b.key, label: q.b.label },
  }));
}

// Draws OU_ITEMS questions from the players the room named in round 1, for the
// same reason round 2 does: it keeps the night one game, and it guarantees the
// names are ones this room has proved it knows.
async function drawOverUnder(session: any): Promise<OuQuestion[]> {
  const pool = (Array.isArray(session.answers_snapshot) ? session.answers_snapshot : []) as PoolEntry[];
  const { data: named } = await db.from("mp_party_answers")
    .select("player_key").eq("session_id", session.id);
  const keys = Array.from(new Set([
    ...(named ?? []).map((a) => a.player_key),
    // Top up from the pool so a short round 1 still produces a full round.
    ...pool.map((p) => p.player_key),
  ])).filter(Boolean).slice(0, 40);
  if (keys.length < 2) return [];

  const cols = ["player_key", "player_name", "notability", ...OU_STATS.map((s) => s.col)];
  const { data: rows } = await db.from("mp_player_facets")
    .select(cols.join(",")).in("player_key", keys);
  // Only players the room would recognise on sight — a fact about someone
  // nobody can place is a coin flip, not an argument.
  const people = (rows ?? []).filter((p: any) => Number(p.notability ?? 0) >= 30);
  if (people.length < 2) return [];

  type Cand = { q: OuQuestion; score: number };
  const cands: Cand[] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const p: any = people[i], r: any = people[j];
      for (const s of OU_STATS) {
        const pv = Number(p[s.col] ?? NaN), rv = Number(r[s.col] ?? NaN);
        if (!isFinite(pv) || !isFinite(rv) || pv === rv) continue;
        // Three things make a question worth asking, in this order.
        //
        // 1. UPSET — the more famous player has FEWER. "Obviously Jordan" being
        //    wrong is the whole game; "obviously Jordan" being right is a
        //    formality. Ties in notability score neither way.
        const pn = Number(p.notability ?? 0), rn = Number(r.notability ?? 0);
        const fameGap = pn - rn;
        const statGap = pv - rv;
        const upset = (fameGap > 0 && statGap < 0) || (fameGap < 0 && statGap > 0);
        // 2. BOTH players recognisable — scored on the LESSER of the two, so a
        //    superstar paired with a journeyman doesn't ride in on one name.
        const fame = Math.min(Math.min(pn, rn), 100) / 5;                  // 0..20
        // 3. A gap you could argue about. Peaks around 0.7 and falls off both
        //    ways: 1-to-30 is a gimme, and 961-games-to-957 is a coin flip
        //    nobody in the room could know. Neither starts an argument.
        const ratio = Math.min(Math.abs(pv), Math.abs(rv)) / Math.max(Math.abs(pv), Math.abs(rv), 1);
        const arguable = (1 - Math.min(1, Math.abs(ratio - 0.7) / 0.7)) * 12;  // 0..12
        cands.push({
          score: (upset ? 60 : 0) + fame + arguable + Math.random() * 4,
          q: {
            key: "", stat: s.key, ask: s.ask,
            a: { key: p.player_key, label: p.player_name, v: pv, shown: s.fmt(pv) },
            b: { key: r.player_key, label: r.player_name, v: rv, shown: s.fmt(rv) },
            answer: pv > rv ? "a" : "b",
          },
        });
      }
    }
  }
  cands.sort((x, y) => y.score - x.score);

  // Spread it out so five questions feel like five questions: no stat asked
  // twice, nobody in more than two, and — the one that actually bit — never the
  // same MATCHUP twice. Capping players alone still served "Kobe or Jordan" on
  // All-NBA and then again on All-Stars, which reads as one question stuttering.
  const out: OuQuestion[] = [];
  const seenPlayer = new Map<string, number>();
  const seenStat = new Set<string>();
  const seenPair = new Set<string>();
  for (const c of cands) {
    if (out.length >= OU_ITEMS) break;
    const { a, b } = c.q;
    const pair = [a.key, b.key].sort().join("|");
    if (seenStat.has(c.q.stat) || seenPair.has(pair)) continue;
    if ((seenPlayer.get(a.key) ?? 0) >= 2 || (seenPlayer.get(b.key) ?? 0) >= 2) continue;
    seenStat.add(c.q.stat); seenPair.add(pair);
    seenPlayer.set(a.key, (seenPlayer.get(a.key) ?? 0) + 1);
    seenPlayer.set(b.key, (seenPlayer.get(b.key) ?? 0) + 1);
    out.push({ ...c.q, key: "q" + (out.length + 1) });
  }
  // A thin room can run out of distinct stats before it runs out of questions.
  // Better a three-question round than a padded one.
  return out;
}

// Correctness bands. A different vocabulary from SPICE_TITLES on purpose — that
// one grades how far from the room you were, this one grades how right you
// were, and reusing it would imply the two rounds measure the same thing.
const OU_TITLES: { min: number; emoji: string; title: string }[] = [
  { min: 1.0, emoji: "🧠", title: "Knows ball" },
  { min: 0.75, emoji: "📚", title: "Did the reading" },
  { min: 0.5, emoji: "🎲", title: "Coin flip merchant" },
  { min: 0.25, emoji: "🫠", title: "Confidently wrong" },
  { min: -1, emoji: "🤡", title: "Every single one" },
];

function overUnderReveal(round: any, boards: any[], emoji?: Map<string, string>) {
  const items = (round.item_set ?? []) as OuQuestion[];
  if (!items.length) return { unlocked: false, have: boards.length, questions: [], scores: [], fooled: null };

  const questions = items.map((q) => {
    let a = 0, b = 0;
    for (const bd of boards) {
      const v = (bd.assignments || {})[q.key];
      if (v === "a") a++; else if (v === "b") b++;
    }
    const majority = a === b ? null : (a > b ? "a" : "b");
    return {
      key: q.key, ask: q.ask,
      a: { label: q.a.label, shown: q.a.shown, votes: a },
      b: { label: q.b.label, shown: q.b.shown, votes: b },
      answer: q.answer,
      winner: q.answer === "a" ? q.a.label : q.b.label,
      // The room got it wrong as a room. A tie is not "fooled" — nobody led.
      room_wrong: majority != null && majority !== q.answer,
    };
  });

  const scores = boards.map((bd) => {
    let right = 0, answered = 0;
    for (const q of items) {
      const v = (bd.assignments || {})[q.key];
      if (v !== "a" && v !== "b") continue;
      answered++;
      if (v === q.answer) right++;
    }
    const pct = answered ? right / answered : 0;
    const band = OU_TITLES.find((t) => pct >= t.min)!;
    return {
      member_id: bd.member_id, label: bd.member_label,
      member_emoji: emoji?.get(bd.member_id) ?? null,
      right, answered, emoji: band.emoji, title: band.title,
    };
  }).sort((x, y) => y.right - x.right || x.label.localeCompare(y.label));

  // The single best moment in the round: the one the room got wrong together.
  // Widest margin first, so it is the most confidently wrong one.
  const fooled = questions.filter((q) => q.room_wrong)
    .sort((x, y) => Math.abs(y.a.votes - y.b.votes) - Math.abs(x.a.votes - x.b.votes))[0] ?? null;

  return { unlocked: boards.length > 0, have: boards.length, questions, scores, fooled };
}

// Everything a client needs to render whichever round the room is on. Shared by
// join and state so a late joiner lands mid-night in the right place.
async function roundStateFor(session: any, rounds: any[], memberId: string | null) {
  const { live, pending, ended } = roundPhase(rounds);
  const out: Record<string, unknown> = {
    rounds: rounds.map((r) => publicRound(r)),
    round: null,
    next_round: pending ? publicRound(pending) : null,
  };
  const cur = live ?? ended;
  if (!cur) return out;

  // One shape for both board rounds — they differ only in how the reveal reads
  // the assignments, so everything up to that line is shared.
  if (BOARD_ROUNDS.has(cur.kind)) {
    const { data: boards } = await db.from("mp_party_round_boards")
      .select("member_id, member_label, assignments, submitted_at").eq("round_id", cur.id);
    const rows = boards ?? [];
    const mine = memberId ? rows.find((b) => b.member_id === memberId) : null;
    // Two different facts, and conflating them is what left the host guessing:
    // a board EXISTS the moment anyone taps a number, because the round
    // autosaves. Only submitted_at means "I'm done, move us on".
    const submitted = rows.filter((b) => b.submitted_at);
    out.round = publicRound(cur, {
      // While live: only WHO has locked in, never what they said.
      boards_saved: rows.length,
      saved_by: rows.map((b) => b.member_label),
      submitted: submitted.length,
      submitted_ids: submitted.map((b) => b.member_id),
      your_assignments: mine?.assignments ?? {},
      your_submitted: !!mine?.submitted_at,
      reveal: cur.status !== "ended" ? null
        : cur.kind === "overunder"
          ? overUnderReveal(cur, rows, await emojiMap(session.id))
          : consensusReveal(cur, rows, await emojiMap(session.id)),
    });
    return out;
  }

  if (cur.kind === "sudden") {
    const pool = (Array.isArray(session.answers_snapshot) ? session.answers_snapshot : []) as PoolEntry[];
    const nameOf = new Map(pool.map((p) => [p.player_key, p.display_name]));
    const [{ data: alive }, { data: turns }] = await Promise.all([
      db.rpc("mp_party_alive", { p_round: cur.id }),
      db.from("mp_party_turns").select("member_id, member_label, guess, player_key, outcome")
        .eq("round_id", cur.id).order("id", { ascending: true }),
    ]);
    const log = turns ?? [];
    out.round = publicRound(cur, {
      alive: (alive ?? []).map((a: any) => ({ member_id: a.member_id, label: a.label })),
      eliminated: log.filter((t) => t.outcome !== "correct")
        .map((t) => ({ member_id: t.member_id, label: t.member_label, outcome: t.outcome, guess: t.guess })),
      // Resolved names, not the typed text, so a spent name reads the same to
      // everyone regardless of who shortened it.
      used: log.filter((t) => t.outcome === "correct")
        .map((t) => ({ member_id: t.member_id, label: t.member_label, display_name: nameOf.get(t.player_key ?? "") ?? t.guess })),
    });
    return out;
  }

  out.round = publicRound(cur);
  return out;
}

// Opens a round. rapid gets its clock, consensus gets its five names drawn from
// round 1, sudden gets the first seat in the rotation.
async function startRound(session: any, round: any) {
  const now = new Date();
  const patch: Record<string, unknown> = { status: "live", started_at: now.toISOString() };

  if (round.kind === "rapid" && round.time_limit_s) {
    patch.ends_at = new Date(now.getTime() + round.time_limit_s * 1000).toISOString();
  }
  if (round.kind === "consensus") {
    patch.item_set = await drawConsensusItems(session);
  }
  if (round.kind === "overunder") {
    patch.item_set = await drawOverUnder(session);
  }
  if (round.kind === "sudden") {
    const { data: first } = await db.from("mp_party_members").select("id")
      .eq("session_id", session.id).order("joined_at", { ascending: true }).limit(1).maybeSingle();
    patch.turn_member_id = first?.id ?? null;
    patch.turn_expires_at = new Date(now.getTime() + TURN_S * 1000).toISOString();
  }

  const { data } = await db.from("mp_party_rounds").update(patch)
    .eq("id", round.id).eq("status", "pending").select("*").single();
  return data ?? { ...round, ...patch };
}

async function boardSince(sessionId: string, sinceId: number) {
  const { data } = await db.from("mp_party_answers")
    .select("id, player_key, display_name, rarity_tier, member_id, member_label")
    .eq("session_id", sessionId).gt("id", sinceId).order("id", { ascending: true });
  return (data ?? []).map((a) => ({
    id: a.id, player_key: a.player_key, display_name: a.display_name,
    rarity_tier: a.rarity_tier, rarity_label: RARITY_LABEL[a.rarity_tier ?? ""] ?? null,
    // member_id rides along so the client can badge the row with whoever said it.
    // The label is denormalised here (it survives a rename mid-game); the emoji is
    // looked up live from PARTY.members, so it cannot go stale.
    member_id: a.member_id, member_label: a.member_label,
  }));
}

async function answerCount(sessionId: string): Promise<number> {
  const { count } = await db.from("mp_party_answers")
    .select("player_key", { count: "exact", head: true }).eq("session_id", sessionId);
  return count ?? 0;
}

async function loadSessionByCode(code: string) {
  const { data } = await db.from("mp_party_sessions").select("*")
    .eq("code", code.trim().toUpperCase()).maybeSingle();
  return data;
}

// Verifies the caller is a real member of this session. Party play is anonymous,
// so the member_token is the only credential.
async function requireMember(sessionId: string, memberId: string, token: string) {
  if (!memberId || !token) return null;
  const { data } = await db.from("mp_party_members").select("id, label")
    .eq("id", memberId).eq("session_id", sessionId).eq("member_token", token).maybeSingle();
  return data;
}

// -----------------------------------------------------------------------------
// The Pickup browse screen. Same shape as challenge_catalog and the same
// categories table, because these are the same kind of content asked a different
// way — a second taxonomy for the same 30-odd prompts would be a thing to keep in
// sync for no gain.
//
// SEVERAL featured, not one. The single-hero rule exists for tier themes, where a
// consensus gate needs three boards on the same set and concentration is the
// point. A Pickup prompt has no gate, and a host scanning for something the room
// will enjoy wants options, not an editorial pick.
//
// `prompts` is still returned, flat, because the old dropdown consumed it and a
// cached client shell will keep calling this until its service worker turns over.
export async function actionPartyPrompts() {
  const [{ data: cats }, { data: rows }] = await Promise.all([
    db.from("mp_challenge_categories")
      .select("slug, label, blurb, icon, sort_order")
      .eq("status", "approved").order("sort_order", { ascending: true }),
    db.from("mp_party_prompts")
      // never the pool — it is the answer key
      .select("slug, prompt, target, item_type, category_slug, title, blurb, featured, sort_order")
      .eq("status", "approved").order("sort_order", { ascending: true }),
  ]);

  const all = (rows ?? []).map((p) => ({
    slug: p.slug, prompt: p.prompt, target: p.target, item_type: p.item_type,
    title: p.title ?? p.prompt, blurb: p.blurb ?? null,
    category: p.category_slug, featured: !!p.featured,
  }));
  const categories = (cats ?? []).map((c) => ({
    slug: c.slug, label: c.label, blurb: c.blurb, icon: c.icon,
    items: all.filter((x) => x.category === c.slug),
  })).filter((c) => c.items.length > 0);

  return ok({
    featured: all.filter((x) => x.featured),
    categories,
    total: all.length,
    prompts: all,           // legacy flat list, for shells cached before this shipped
  });
}

export async function actionPartyCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!clientId) return err("identity_required", 400);

  // Two ways in: a curated prompt by slug, or a filter set the host built. Both
  // end at the same place — a frozen pool on the session — so nothing downstream
  // (join, guess, state, recap) needs to know which route was taken.
  let promptId: string | null = null;
  let promptText: string;
  let target: number;
  let pool: unknown;

  if (body.filters || body.college || body.conference || body.team ||
      body.position || body.decade || body.award || body.draft) {
    const built = buildChallengeFilters({ ...(body.filters ?? body), mode: "roster" });
    if ("error" in built) return err(built.error, 400);
    const f = built.filters;
    delete (f as any).mode;      // party has no top8/roster distinction
    delete (f as any).target;    // the room's ask is derived, not requested
    if (!Object.keys(f).length) return err("no_filters", 400);

    const { data: b, error: bErr } = await db.rpc("mp_party_build", { f });
    if (bErr) return err(bErr.message, 500);
    if (!b?.ok) {
      // 200, not an error: "not enough for a room" is an answer the host can act
      // on, and the same shape the Name It gate returns.
      return ok({ built: false, reason: b?.reason ?? "too_thin", known: b?.known ?? 0 });
    }
    promptText = composeFilterSubject(f as any);
    target = b.target;
    pool = b.pool;
  } else {
    const slug = String(body.slug ?? "");
    const { data: prompt } = await db.from("mp_party_prompts").select("*")
      .eq("slug", slug).eq("status", "approved").maybeSingle();
    if (!prompt) return err("unknown_prompt", 404);
    promptId = prompt.id; promptText = prompt.prompt;
    target = prompt.target; pool = prompt.pool;
  }

  // 3 / 5 / 10 minutes, or untimed. Anything else is rejected rather than clamped
  // so a bad client can't quietly create a 6-hour session.
  const raw = body.time_limit_s === null ? null : Number(body.time_limit_s ?? 300);
  if (raw !== null && ![180, 300, 600].includes(raw)) return err("invalid_time_limit", 400);

  // A cached shell never sends `format`, so every session it creates is still
  // 'classic' and behaves exactly as it did before rounds existed.
  const format = body.format === "night" ? "night" : "classic";
  // For a night the ROUND carries the clock (each has a designed length), so the
  // session has none and autoEndIfExpired is a no-op on it. For classic the
  // session clock stays authoritative, untouched.
  const sessionClock = format === "night" ? null : raw;

  const code = await uniquePartyCode();
  const hostToken = randomToken(16);
  const { data: session, error: sErr } = await db.from("mp_party_sessions").insert({
    code, share_token: "party_" + randomToken(8),
    prompt_id: promptId, prompt: promptText, target,
    answers_snapshot: pool,              // freeze: editing the prompt can't change a live game
    status: "lobby", time_limit_s: sessionClock, format,
    host_client_id: clientId, host_token: hostToken,
  }).select("*").single();
  if (sErr) return err(sErr.message, 500);

  // Rounds are written for BOTH formats so the server has one code path; classic
  // simply has one, and the client branches on rounds.length.
  const roundRows = format === "night"
    ? [
        { idx: 1, kind: "rapid", prompt: promptText, target, time_limit_s: RAPID_S },
        { idx: 2, kind: "consensus", prompt: "Put five of them in order", tiers: CONSENSUS_RANKS },
        // Deliberately third: a fast round with right answers between the long
        // opinion round and the elimination one, so the night escalates rather
        // than sagging in the middle.
        { idx: 3, kind: "overunder", prompt: "Who's got more?", tiers: OU_SIDES },
        { idx: 4, kind: "sudden", prompt: promptText },
      ]
    : [{ idx: 1, kind: "rapid", prompt: promptText, target, time_limit_s: raw }];
  const { error: rErr } = await db.from("mp_party_rounds")
    .insert(roundRows.map((r) => ({ ...r, session_id: session.id })));
  if (rErr) return err(rErr.message, 500);

  const memberToken = randomToken(16);
  const { data: member } = await db.from("mp_party_members").insert({
    session_id: session.id, client_id: clientId, user_id: userId,
    label: cleanLabel(body.label, "Host"), member_token: memberToken,
  }).select("id, label").single();

  return ok({
    session: publicSession(session), host_token: hostToken,
    member_id: member?.id, member_token: memberToken, is_host: true,
    members: await loadMembers(session.id),
    rounds: (await loadRounds(session.id)).map((r) => publicRound(r)),
  });
}

// Idempotent for a returning device: a refresh, a reconnect, or a phone locking
// mid-game must resume the same member rather than minting a second identity.
// Works in `live` as well as `lobby` — late joiners are the norm at a party.
export async function actionPartyJoin(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!clientId) return err("identity_required", 400);

  const session = body.code ? await loadSessionByCode(String(body.code)) : null;
  if (!session) return err("unknown_session", 404);
  if (new Date(session.expires_at).getTime() < Date.now()) return err("session_expired", 410);
  const live = await autoEndIfExpired(session);
  if (live.status === "ended") return err("session_ended", 410);

  // Resume by token first, then by device. Either path returns the original member.
  let member = null;
  if (body.member_token) {
    const { data } = await db.from("mp_party_members").select("id, label, member_token")
      .eq("session_id", live.id).eq("member_token", String(body.member_token)).maybeSingle();
    member = data;
  }
  if (!member) {
    const { data } = await db.from("mp_party_members").select("id, label, member_token")
      .eq("session_id", live.id).eq("client_id", clientId).maybeSingle();
    member = data;
  }
  // Re-joining with a name attached is how renaming works — no separate action,
  // and it keeps the join path free of a blocking name prompt.
  if (member && body.label) {
    const label = cleanLabel(body.label);
    if (label !== member.label) {
      await db.from("mp_party_members").update({ label }).eq("id", member.id);
      await db.from("mp_party_answers").update({ member_label: label })
        .eq("session_id", live.id).eq("member_id", member.id);
      member.label = label;
    }
  }
  if (!member) {
    const token = randomToken(16);
    const { data, error } = await db.from("mp_party_members").insert({
      session_id: live.id, client_id: clientId, user_id: userId,
      label: cleanLabel(body.label), member_token: token,
    }).select("id, label, member_token").single();
    if (error) {
      // Lost a race with our own other tab — the partial unique index fired.
      // Re-read rather than surfacing a failure.
      if (error.code === PG_UNIQUE_VIOLATION) {
        const { data: existing } = await db.from("mp_party_members").select("id, label, member_token")
          .eq("session_id", live.id).eq("client_id", clientId).maybeSingle();
        member = existing;
      }
      if (!member) return err(error.message, 500);
    } else member = data;
  }

  return ok({
    session: publicSession(live),
    member_id: member!.id, member_token: member!.member_token,
    is_host: live.host_client_id === clientId,
    members: await loadMembers(live.id),
    board: await boardSince(live.id, 0),
    count: await answerCount(live.id),
    // A late joiner lands wherever the room already is, mid-night included.
    ...(await roundStateFor(live, await loadRounds(live.id), member!.id)),
  });
}

export async function actionPartyStart(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  if (session.host_token !== String(body.host_token ?? "")) return err("only_host_can_start", 403);
  if (session.status === "ended") return err("session_ended", 410);
  if (session.status === "live") return ok({ session: publicSession(session), already: true });

  const startedAt = new Date();
  const endsAt = session.time_limit_s
    ? new Date(startedAt.getTime() + session.time_limit_s * 1000).toISOString() : null;
  const { data: updated } = await db.from("mp_party_sessions")
    .update({ status: "live", started_at: startedAt.toISOString(), ends_at: endsAt })
    .eq("id", session.id).eq("status", "lobby").select("*").single();
  const s = updated ?? session;

  // Opening the session opens round 1. A session created before rounds existed
  // has none, and simply gets no round state — the classic path is unaffected.
  const rounds = await loadRounds(s.id);
  const first = rounds.find((r) => r.status === "pending");
  if (first) await startRound(s, first);

  return ok({
    session: publicSession(s),
    ...(await roundStateFor(s, await loadRounds(s.id), null)),
  });
}

export async function actionPartyGuess(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  const member = await requireMember(session.id, String(body.member_id ?? ""), String(body.member_token ?? ""));
  if (!member) return err("not_a_member", 403);

  const live = await autoEndIfExpired(session);
  if (live.status !== "live") return err("session_not_live", 409, { status: live.status });

  // Shouting only belongs in the rapid round. Without this guard a client cached
  // mid-night — or one that missed a round transition — would post names into a
  // tier round and get them silently counted against the wrong game.
  let rounds = await loadRounds(live.id);
  let rapid = roundPhase(rounds).live;
  if (rapid) {
    rapid = await autoEndRoundIfExpired(rapid);
    if (rapid.status !== "live") { rounds = await loadRounds(live.id); rapid = null; }
  }
  if (rounds.length && (!rapid || rapid.kind !== "rapid")) {
    const s = await syncSessionEnd(live, await loadRounds(live.id));
    return err("round_not_rapid", 409, {
      status: s.status,
      ...(await roundStateFor(s, await loadRounds(live.id), member.id)),
    });
  }

  const norm = normalize(String(body.guess ?? ""));
  if (!norm) return err("empty_guess", 400);

  const pool = (Array.isArray(live.answers_snapshot) ? live.answers_snapshot : []) as PoolEntry[];
  const hit = matchPoolGuess(pool, norm);
  const sinceId = Number(body.since_id ?? 0);

  if (!hit) {
    // A miss is a stat, never a penalty. Atomic bump — no read-modify-write.
    await db.rpc("mp_party_bump_miss", { p_session: live.id });
    return ok({
      result: "miss", count: await answerCount(live.id), target: live.target,
      answers: await boardSince(live.id, sinceId),
      seconds_left: secondsLeft(live), round_seconds_left: roundSecondsLeft(rapid),
    });
  }

  const { error: iErr } = await db.from("mp_party_answers").insert({
    session_id: live.id, player_key: hit.player_key, display_name: hit.display_name,
    rarity_tier: hit.rarity_tier, member_id: member.id, member_label: member.label,
  });

  if (iErr) {
    // Someone else got there first. Friendlier than a strike, and the reason the
    // dedupe lives in the primary key instead of in JavaScript.
    if (iErr.code === PG_UNIQUE_VIOLATION) {
      const { data: prior } = await db.from("mp_party_answers")
        .select("member_label").eq("session_id", live.id).eq("player_key", hit.player_key).maybeSingle();
      return ok({
        result: "duplicate", display_name: hit.display_name,
        claimed_by: prior?.member_label ?? null,
        count: await answerCount(live.id), target: live.target,
        answers: await boardSince(live.id, sinceId), seconds_left: secondsLeft(live),
        round_seconds_left: roundSecondsLeft(rapid),
      });
    }
    return err(iErr.message, 500);
  }

  const count = await answerCount(live.id);
  const finished = count >= live.target;
  if (finished) {
    // Filling the board ends the ROUND. A classic session has only that one, so
    // syncSessionEnd then ends the session — the same outcome as before rounds
    // existed. For a night it is intermission and the night carries on.
    if (rapid) {
      await db.from("mp_party_rounds")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("id", rapid.id).eq("status", "live");
      await syncSessionEnd(live, await loadRounds(live.id));
    } else {
      // A session created before rounds existed has no rows to close, and
      // syncSessionEnd deliberately no-ops on an empty set — so end it the old
      // way or an in-flight game would never finish.
      await db.from("mp_party_sessions")
        .update({ status: "ended", ended_at: new Date().toISOString() })
        .eq("id", live.id).eq("status", "live");
    }
  }

  return ok({
    result: "correct", display_name: hit.display_name,
    rarity_tier: hit.rarity_tier, rarity_label: RARITY_LABEL[hit.rarity_tier] ?? hit.rarity_tier,
    count, target: live.target, finished,
    answers: await boardSince(live.id, sinceId),   // piggybacked delta: the typer never waits
    seconds_left: secondsLeft(live),
    round_seconds_left: roundSecondsLeft(rapid),   // free: rapid is already in hand
    // Only on the round boundary. roundStateFor costs several queries and the
    // typer must never wait for them on an ordinary guess.
    ...(finished ? await roundStateFor(live, await loadRounds(live.id), member.id) : {}),
  });
}

export async function actionPartyState(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  let live = await autoEndIfExpired(session);

  // Two lazy sweeps, both idempotent, both driven by whoever polls: a round whose
  // clock ran out, and a sudden-death seat that stalled. Neither depends on the
  // host's device being awake.
  let rounds = await loadRounds(live.id);
  const active = roundPhase(rounds).live;
  if (active) {
    const after = active.kind === "sudden"
      ? await autoAdvanceTurn(active)
      : await autoEndRoundIfExpired(active);
    if (after.status !== active.status || after.turn_seq !== active.turn_seq) {
      rounds = await loadRounds(live.id);
    }
  }
  live = await syncSessionEnd(live, rounds);

  const sinceId = Number(body.since_id ?? 0);
  const out: Record<string, unknown> = {
    session: publicSession(live), members: await loadMembers(live.id),
    answers: await boardSince(live.id, sinceId), count: await answerCount(live.id),
    ...(await roundStateFor(live, rounds, body.member_id ? String(body.member_id) : null)),
  };
  if (live.status === "ended") out.recap = await buildRecap(live, rounds);
  return ok(out);
}

export async function actionPartyEnd(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  if (session.host_token !== String(body.host_token ?? "")) return err("only_host_can_end", 403);
  if (session.status !== "ended") {
    await db.from("mp_party_sessions")
      .update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", session.id);
    session.status = "ended";
  }
  // Ending the session abandons any round still open — the recap reports what
  // each one got to rather than pretending the night finished.
  await endOpenRounds(session.id);
  const rounds = await loadRounds(session.id);
  return ok({ session: publicSession(session), recap: await buildRecap(session, rounds) });
}

// ---------------------------------------------------------------------------
// Host advances the night, ONE BEAT PER CALL.
//
// Closing a round and opening the next used to happen in a single call, which
// skipped straight past the intermission — and for round 2 the intermission IS
// the payoff: the room never got to see whose take was the Menace. So a live
// round ends here and stops; a second call opens the next one.
// ---------------------------------------------------------------------------
export async function actionPartyRoundNext(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  if (session.host_token !== String(body.host_token ?? "")) return err("only_host_can_advance", 403);

  const memberId = body.member_id ? String(body.member_id) : null;
  let rounds = await loadRounds(session.id);
  if (!rounds.length) return err("no_rounds", 409);

  const live = roundPhase(rounds).live;
  if (live) {
    await db.from("mp_party_rounds")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", live.id).eq("status", "live");
    rounds = await loadRounds(session.id);
    // Nothing left to play: the night is over and the recap is the next screen.
    if (!roundPhase(rounds).pending) {
      const done = await syncSessionEnd(session, rounds);
      return ok({
        session: publicSession(done), ...(await roundStateFor(done, rounds, memberId)),
        recap: await buildRecap(done, rounds),
      });
    }
    // Otherwise stop at the intermission so the room can look at what just happened.
    return ok({ session: publicSession(session), ...(await roundStateFor(session, rounds, memberId)) });
  }

  const next = roundPhase(rounds).pending;
  if (next) {
    await startRound(session, next);
    rounds = await loadRounds(session.id);
    return ok({ session: publicSession(session), ...(await roundStateFor(session, rounds, memberId)) });
  }

  const ended = await syncSessionEnd(session, rounds);
  return ok({
    session: publicSession(ended), ...(await roundStateFor(ended, rounds, memberId)),
    recap: await buildRecap(ended, rounds),
  });
}

// ---------------------------------------------------------------------------
// One board per member, upserted on the primary key. Serves BOTH board rounds —
// round 2's 1-to-5 ordering and round 3's a/b votes — because they are the same
// operation over a different vocabulary: validate the keys against item_set and
// the values against `tiers`, then upsert.
//
// Two things arrive on this action because they are one user gesture apart: the
// autosave that fires on every tap, and the explicit "Lock it in" that tells the
// host the room can move. `submit` is tri-state — absent leaves the flag alone
// (an autosave must never un-submit a locked board), true locks, false unlocks
// so a mis-tap is recoverable.
// ---------------------------------------------------------------------------
export async function actionPartyTierSave(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("id")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  const member = await requireMember(session.id, String(body.member_id ?? ""), String(body.member_token ?? ""));
  if (!member) return err("not_a_member", 403);

  const { data: round } = await db.from("mp_party_rounds").select("*")
    .eq("id", body.round_id).eq("session_id", session.id).maybeSingle();
  if (!round) return err("unknown_round", 404);
  if (!BOARD_ROUNDS.has(round.kind)) return err("wrong_round_kind", 409);
  if (round.status !== "live") return err("round_not_live", 409, { status: round.status });

  // Same validation shape as actionTierSave: anything not in this round's item_set
  // and label vocabulary is dropped rather than trusted.
  const validKeys = new Set(((round.item_set ?? []) as TierItem[]).map((i) => i.key));
  const validTiers = new Set((round.tiers ?? CONSENSUS_RANKS) as string[]);
  // A RANK is a position, so two players cannot hold the same one. Partial is
  // fine — this autosaves while someone is still deciding — but a duplicate is
  // never legitimate, and the server can't take the client's word that its swap
  // logic ran. First writer keeps the slot.
  //
  // ⚠️ That rule is specific to the ordering round and must not be generalised:
  // in Who's Got More every answer is "a" or "b", so five questions share two
  // values by construction and de-duping would throw three of them away.
  const oneEach = round.kind === "consensus";
  const asg: Record<string, string> = {};
  const taken = new Set<string>();
  for (const [k, v] of Object.entries(body.assignments ?? {})) {
    if (!validKeys.has(k) || !validTiers.has(v as string)) continue;
    if (oneEach) {
      if (taken.has(v as string)) continue;
      taken.add(v as string);
    }
    asg[k] = v as string;
  }

  // Locking in a half-finished order would tell the host the room is ready when
  // it is not, so the full ordering is the price of the signal. Unlocking is
  // always allowed.
  const incomplete = body.submit === true && Object.keys(asg).length < validKeys.size;

  const row: Record<string, unknown> = {
    round_id: round.id, member_id: member.id, member_label: member.label,
    assignments: asg, updated_at: new Date().toISOString(),
  };
  // Only touch submitted_at when the caller said something about it — an
  // autosave (submit absent) must leave a locked board locked.
  if (body.submit === true && !incomplete) row.submitted_at = new Date().toISOString();
  if (body.submit === false) row.submitted_at = null;

  // Store first, refuse second. Rejecting outright would discard the taps this
  // call carried — the order is saved on every tap precisely so nobody can lose
  // work, and a refused SUBMIT is no reason to break that.
  const { error } = await db.from("mp_party_round_boards")
    .upsert(row, { onConflict: "round_id,member_id" });
  if (error) return err(error.message, 500);
  if (incomplete) {
    return err("ranking_incomplete", 409, { rated: Object.keys(asg).length, need: validKeys.size });
  }

  const { data: rows } = await db.from("mp_party_round_boards")
    .select("member_id, submitted_at").eq("round_id", round.id);
  const boards = rows ?? [];
  const submitted = boards.filter((b) => b.submitted_at);
  return ok({
    saved: true, boards_saved: boards.length,
    submitted: submitted.length, submitted_ids: submitted.map((b) => b.member_id),
    // Read back rather than echoing `submit`: an autosave leaves the flag alone,
    // so echoing the request would report a locked board as unlocked and the
    // client would re-enable the buttons under the player.
    your_submitted: submitted.some((b) => b.member_id === member.id),
    members: (await loadMembers(session.id)).length,
    rated: Object.keys(asg).length,
  });
}

// ---------------------------------------------------------------------------
// Round 3: one seat at a time, arbitrated by turn_seq.
//
// Elimination on a wrong name deliberately contradicts the no-strikes rule that
// governs the rapid round. That rule protects a CO-OP game from being ended by
// one person's bad guess; here elimination is the game, and the room opted into
// it by starting the round. Do not reconcile the two.
// ---------------------------------------------------------------------------
export async function actionPartyTurn(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  const member = await requireMember(session.id, String(body.member_id ?? ""), String(body.member_token ?? ""));
  if (!member) return err("not_a_member", 403);

  let rounds = await loadRounds(session.id);
  let round = roundPhase(rounds).live;
  if (!round || round.kind !== "sudden") return err("round_not_live", 409);
  // The clock may already have passed while this request was in flight.
  round = await autoAdvanceTurn(round);
  if (round.status !== "live") {
    rounds = await loadRounds(session.id);
    const s = await syncSessionEnd(session, rounds);
    return err("round_not_live", 409, {
      ...(await roundStateFor(s, rounds, member.id)),
    });
  }
  if (round.turn_member_id !== member.id) {
    return err("not_your_turn", 409, { turn_member_id: round.turn_member_id, turn_seq: round.turn_seq });
  }
  // The client echoes the seq it rendered. A mismatch means it acted on a stale
  // view of whose turn it was — refuse rather than spend someone else's turn.
  if (body.turn_seq != null && Number(body.turn_seq) !== round.turn_seq) {
    return err("not_your_turn", 409, { turn_member_id: round.turn_member_id, turn_seq: round.turn_seq });
  }

  const raw = String(body.guess ?? "").slice(0, 60);
  const norm = normalize(raw);
  if (!norm) return err("empty_guess", 400);

  const pool = (Array.isArray(session.answers_snapshot) ? session.answers_snapshot : []) as PoolEntry[];
  const hit = matchPoolGuess(pool, norm);

  let outcome: "correct" | "miss" | "duplicate" = hit ? "correct" : "miss";
  if (hit) {
    const { error } = await db.from("mp_party_turns").insert({
      round_id: round.id, member_id: member.id, member_label: member.label,
      guess: raw, player_key: hit.player_key, outcome: "correct",
    });
    if (error) {
      // The unique index is the dedupe: a name already spent in this round loses
      // the insert rather than being checked for in JavaScript.
      if (error.code !== PG_UNIQUE_VIOLATION) return err(error.message, 500);
      outcome = "duplicate";
      // player_key null so the eliminating row can't collide with the index; the
      // outcome alone is what mp_party_alive reads.
      await db.from("mp_party_turns").insert({
        round_id: round.id, member_id: member.id, member_label: member.label,
        guess: raw, player_key: null, outcome: "duplicate",
      });
    }
  } else {
    await db.from("mp_party_turns").insert({
      round_id: round.id, member_id: member.id, member_label: member.label,
      guess: raw, player_key: null, outcome: "miss",
    });
  }

  const { data: adv } = await db.rpc("mp_party_advance_turn", {
    p_round: round.id, p_expect_seq: round.turn_seq, p_turn_s: TURN_S, p_timeout: false,
  });

  rounds = await loadRounds(session.id);
  const s = await syncSessionEnd(session, rounds);
  return ok({
    result: outcome,
    display_name: hit?.display_name ?? null,
    rarity_tier: hit?.rarity_tier ?? null,
    rarity_label: hit ? (RARITY_LABEL[hit.rarity_tier] ?? hit.rarity_tier) : null,
    advance: adv ?? null,
    session: publicSession(s),
    ...(await roundStateFor(s, rounds, member.id)),
    ...(s.status === "ended" ? { recap: await buildRecap(s, rounds) } : {}),
  });
}

// The recap is the product: it's what gets screenshotted into the group chat.
//
// The top-level shape is UNCHANGED from before rounds existed — a classic
// session's numbers are its rapid round's numbers, so the client's existing
// renderer keeps working byte for byte. A night adds rounds[] alongside it.
//
// There is deliberately no combined score. Three rounds pay off in three
// different currencies — a team number, a joke title, a survivor — so different
// people win different things. Totalling them would crown one person and undo
// the reason the co-op round has no leaderboard.
async function buildRecap(session: any, rounds: any[] = []) {
  const { data: rows } = await db.from("mp_party_answers")
    .select("player_key, display_name, rarity_tier, member_id, member_label")
    .eq("session_id", session.id).order("id", { ascending: true });
  const answers = rows ?? [];
  const emoji = await emojiMap(session.id);

  // Keyed on member_id, not the label: two people in a room can pick the same
  // name, and merging their counts would credit one of them with both.
  const byMember = new Map<string, { label: string; emoji: string | null; n: number }>();
  for (const a of answers) {
    const k = a.member_id ?? a.member_label ?? "someone";
    const cur = byMember.get(k);
    if (cur) cur.n++;
    else byMember.set(k, { label: a.member_label ?? "Someone", emoji: emoji.get(a.member_id) ?? null, n: 1 });
  }

  const pool = (Array.isArray(session.answers_snapshot) ? session.answers_snapshot : []) as PoolEntry[];
  const found = new Set(answers.map((a) => a.player_key));
  // rosterReveal already sorts by fame, so filtering it yields the most famous
  // names nobody said — the "oh come ON" moment.
  const missed = rosterReveal(pool.filter((p) => !found.has(p.player_key)), 5)
    .map((m) => ({ display_name: m.display_name, context_label: m.context_label }));

  const base = {
    prompt: session.prompt, target: session.target,
    count: answers.length, misses: session.misses,
    deep_cuts: answers.filter((a) => a.rarity_tier === "deep_cut")
      .map((a) => a.display_name),
    contributors: Array.from(byMember, ([member_id, v]) => ({ member_id, ...v }))
      .sort((a, b) => b.n - a.n),
    missed,
  };

  const perRound: Record<string, unknown>[] = [];
  for (const r of rounds) {
    const head = { idx: r.idx, kind: r.kind, label: ROUND_LABEL[r.kind] ?? r.kind, status: r.status };

    if (r.kind === "rapid") {
      perRound.push({ ...head, ...base });
      continue;
    }

    if (BOARD_ROUNDS.has(r.kind)) {
      const { data: boards } = await db.from("mp_party_round_boards")
        .select("member_id, member_label, assignments").eq("round_id", r.id);
      // The recap only exists once the night is over, so the answers are no
      // longer secret — itemSetFor still gates on r.status for the abandoned
      // case, where a round the room never finished must stay sealed.
      perRound.push({
        ...head, prompt: r.prompt, item_set: itemSetFor(r), tiers: r.tiers ?? CONSENSUS_RANKS,
        reveal: r.kind === "overunder"
          ? overUnderReveal(r, boards ?? [], emoji)
          : consensusReveal(r, boards ?? [], emoji),
      });
      continue;
    }

    if (r.kind === "sudden") {
      const [{ data: alive }, { data: turns }] = await Promise.all([
        db.rpc("mp_party_alive", { p_round: r.id }),
        db.from("mp_party_turns").select("member_id, member_label, guess, player_key, outcome")
          .eq("round_id", r.id).order("id", { ascending: true }),
      ]);
      const log = turns ?? [];
      const standing = (alive ?? []).map((a: any) => ({
        member_id: a.member_id, label: a.label as string, emoji: emoji.get(a.member_id) ?? null,
      }));
      const said = new Map<string, { label: string; emoji: string | null; n: number }>();
      for (const t of log) {
        if (t.outcome !== "correct") continue;
        const k = t.member_id ?? t.member_label ?? "someone";
        const cur = said.get(k);
        if (cur) cur.n++;
        else said.set(k, { label: t.member_label ?? "Someone", emoji: emoji.get(t.member_id) ?? null, n: 1 });
      }
      perRound.push({
        ...head, prompt: r.prompt,
        // One survivor is a winner. A round abandoned early leaves several
        // standing, and picking one of them would be a lie.
        survivor: standing.length === 1 ? standing[0].label : null,
        survivor_emoji: standing.length === 1 ? standing[0].emoji : null,
        still_standing: standing.map((s: { label: string }) => s.label),
        names: log.filter((t) => t.outcome === "correct").length,
        knocked_out: log.filter((t) => t.outcome !== "correct")
          .map((t) => ({
            member_id: t.member_id, label: t.member_label, emoji: emoji.get(t.member_id) ?? null,
            outcome: t.outcome, guess: t.guess,
          })),
        said: Array.from(said, ([member_id, v]) => ({ member_id, ...v })).sort((a, b) => b.n - a.n),
      });
    }
  }

  return { ...base, format: session.format ?? "classic", rounds: perRound };
}
