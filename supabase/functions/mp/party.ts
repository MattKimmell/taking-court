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
const ROUND_LABEL: Record<string, string> = {
  rapid: "Rapid Fire", consensus: "Guess the Room", sudden: "Sudden Death",
};

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

// item_set is safe to expose — the five names to rank ARE the round. Nothing here
// leaks the answer pool or anyone else's assignments.
function publicRound(r: any, extra: Record<string, unknown> = {}) {
  if (!r) return null;
  return {
    id: r.id, idx: r.idx, kind: r.kind, label: ROUND_LABEL[r.kind] ?? r.kind,
    status: r.status, prompt: r.prompt, target: r.target,
    item_set: r.kind === "consensus" ? (r.item_set ?? []) : null,
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
function consensusReveal(round: any, boards: any[]) {
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
      label: b.member_label,
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

  if (cur.kind === "consensus") {
    const { data: boards } = await db.from("mp_party_round_boards")
      .select("member_id, member_label, assignments").eq("round_id", cur.id);
    const rows = boards ?? [];
    const mine = memberId ? rows.find((b) => b.member_id === memberId) : null;
    out.round = publicRound(cur, {
      // While live: only WHO has locked in, never what they said.
      boards_saved: rows.length,
      saved_by: rows.map((b) => b.member_label),
      your_assignments: mine?.assignments ?? {},
      reveal: cur.status === "ended" ? consensusReveal(cur, rows) : null,
    });
    return out;
  }

  if (cur.kind === "sudden") {
    const pool = (Array.isArray(session.answers_snapshot) ? session.answers_snapshot : []) as PoolEntry[];
    const nameOf = new Map(pool.map((p) => [p.player_key, p.display_name]));
    const [{ data: alive }, { data: turns }] = await Promise.all([
      db.rpc("mp_party_alive", { p_round: cur.id }),
      db.from("mp_party_turns").select("member_label, guess, player_key, outcome")
        .eq("round_id", cur.id).order("id", { ascending: true }),
    ]);
    const log = turns ?? [];
    out.round = publicRound(cur, {
      alive: (alive ?? []).map((a: any) => ({ member_id: a.member_id, label: a.label })),
      eliminated: log.filter((t) => t.outcome !== "correct")
        .map((t) => ({ label: t.member_label, outcome: t.outcome, guess: t.guess })),
      // Resolved names, not the typed text, so a spent name reads the same to
      // everyone regardless of who shortened it.
      used: log.filter((t) => t.outcome === "correct")
        .map((t) => ({ label: t.member_label, display_name: nameOf.get(t.player_key ?? "") ?? t.guess })),
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
    .select("id, player_key, display_name, rarity_tier, member_label")
    .eq("session_id", sessionId).gt("id", sinceId).order("id", { ascending: true });
  return (data ?? []).map((a) => ({
    id: a.id, player_key: a.player_key, display_name: a.display_name,
    rarity_tier: a.rarity_tier, rarity_label: RARITY_LABEL[a.rarity_tier ?? ""] ?? null,
    member_label: a.member_label,
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
        { idx: 2, kind: "consensus", prompt: "Rank five of them", tiers: CONSENSUS_RANKS },
        { idx: 3, kind: "sudden", prompt: promptText },
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
    members: [{ id: member?.id, label: member?.label }],
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

  const { data: members } = await db.from("mp_party_members")
    .select("id, label").eq("session_id", live.id).order("joined_at", { ascending: true });

  return ok({
    session: publicSession(live),
    member_id: member!.id, member_token: member!.member_token,
    is_host: live.host_client_id === clientId,
    members: members ?? [],
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
  const { data: members } = await db.from("mp_party_members")
    .select("id, label").eq("session_id", live.id).order("joined_at", { ascending: true });

  const out: Record<string, unknown> = {
    session: publicSession(live), members: members ?? [],
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
// Round 2: one board per member, upserted on the primary key.
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
  if (round.kind !== "consensus") return err("wrong_round_kind", 409);
  if (round.status !== "live") return err("round_not_live", 409, { status: round.status });

  // Same validation shape as actionTierSave: anything not in this round's item_set
  // and label vocabulary is dropped rather than trusted.
  const validKeys = new Set(((round.item_set ?? []) as TierItem[]).map((i) => i.key));
  const validTiers = new Set((round.tiers ?? CONSENSUS_RANKS) as string[]);
  const asg: Record<string, string> = {};
  // A rank is a POSITION, so two players cannot hold the same one. Partial is
  // fine — this autosaves while someone is still deciding — but a duplicate is
  // never legitimate, and the server can't take the client's word that its swap
  // logic ran. First writer keeps the slot.
  const taken = new Set<string>();
  for (const [k, v] of Object.entries(body.assignments ?? {})) {
    if (!validKeys.has(k) || !validTiers.has(v as string)) continue;
    if (taken.has(v as string)) continue;
    taken.add(v as string); asg[k] = v as string;
  }

  const { error } = await db.from("mp_party_round_boards").upsert({
    round_id: round.id, member_id: member.id, member_label: member.label,
    assignments: asg, updated_at: new Date().toISOString(),
  }, { onConflict: "round_id,member_id" });
  if (error) return err(error.message, 500);

  const { count } = await db.from("mp_party_round_boards")
    .select("member_id", { count: "exact", head: true }).eq("round_id", round.id);
  const { data: members } = await db.from("mp_party_members")
    .select("id", { count: "exact" }).eq("session_id", session.id);
  return ok({
    saved: true, boards_saved: count ?? 0, members: (members ?? []).length,
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
    .select("player_key, display_name, rarity_tier, member_label")
    .eq("session_id", session.id).order("id", { ascending: true });
  const answers = rows ?? [];

  const byMember = new Map<string, number>();
  for (const a of answers) {
    const k = a.member_label ?? "Someone";
    byMember.set(k, (byMember.get(k) ?? 0) + 1);
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
    contributors: Array.from(byMember, ([label, n]) => ({ label, n }))
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

    if (r.kind === "consensus") {
      const { data: boards } = await db.from("mp_party_round_boards")
        .select("member_id, member_label, assignments").eq("round_id", r.id);
      perRound.push({
        ...head, prompt: r.prompt, item_set: r.item_set ?? [], tiers: r.tiers ?? CONSENSUS_RANKS,
        reveal: consensusReveal(r, boards ?? []),
      });
      continue;
    }

    if (r.kind === "sudden") {
      const [{ data: alive }, { data: turns }] = await Promise.all([
        db.rpc("mp_party_alive", { p_round: r.id }),
        db.from("mp_party_turns").select("member_label, guess, player_key, outcome")
          .eq("round_id", r.id).order("id", { ascending: true }),
      ]);
      const log = turns ?? [];
      const standing = (alive ?? []).map((a: any) => a.label as string);
      const said = new Map<string, number>();
      for (const t of log) {
        if (t.outcome !== "correct") continue;
        const k = t.member_label ?? "Someone";
        said.set(k, (said.get(k) ?? 0) + 1);
      }
      perRound.push({
        ...head, prompt: r.prompt,
        // One survivor is a winner. A round abandoned early leaves several
        // standing, and picking one of them would be a lie.
        survivor: standing.length === 1 ? standing[0] : null,
        still_standing: standing,
        names: log.filter((t) => t.outcome === "correct").length,
        knocked_out: log.filter((t) => t.outcome !== "correct")
          .map((t) => ({ label: t.member_label, outcome: t.outcome, guess: t.guess })),
        said: Array.from(said, ([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
      });
    }
  }

  return { ...base, format: session.format ?? "classic", rounds: perRound };
}
