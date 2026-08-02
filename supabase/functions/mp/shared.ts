// =============================================================================
// Async multiplayer mode for the NBA Top-8 list game.
// Single server-authoritative edge function with an action router.
//
// Why a single function: keeps one public URL and shared helpers. Every action
// runs with the service role, so it (and only it) can read the frozen answer
// set. Clients never touch the mp_* tables directly (RLS deny-all), which is
// what keeps the answers — and each opponent's result — hidden until allowed.
//
// Actions (POST JSON { action, ... }):
//   sheets   -> list the available Top-8 categories (no answers)
//   create   -> create a duel/competition from a category; returns share_token
//   open     -> peek a challenge by share_token (prompt + rules, NO answers)
//   start    -> join (if needed) + start the server clock for this player
//   guess    -> submit one guess; validated + timed on the server
//   results  -> head-to-head / leaderboard (only once the caller has finished)
//
// Timing is server-authoritative: started_at / finished_at / elapsed are set
// from the server clock inside `start` and `guess`; the client cannot supply
// or alter them.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
export const ok = (b: Record<string, unknown> = {}) => json({ ok: true, ...b });
export const err = (msg: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error: msg, ...extra }, status);

// Name normalizer — must stay in sync with public.mp_normalize in SQL:
// accent-fold, lowercase, keep alphanumerics only.
export function normalize(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function randomToken(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Pull an authenticated user id out of the caller's JWT, if present.
// The public anon key has role "anon" (=> no user). A logged-in Supabase user
// token has role "authenticated" and sub = user id.
export function authedUserId(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const t = auth.replace(/^Bearer\s+/i, "");
  const parts = t.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return payload?.role === "authenticated" && payload?.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

export type SnapshotSlot = {
  slot: number;
  display_name: string;
  canonical_key: string;
  context_label: string | null;
  accepted: string[]; // normalized accepted aliases
};

// Build the frozen answer snapshot for a sheet from perfect_sheet_answers +
// aliases. This is stored on the challenge so the game is reproducible and the
// answer set is fixed even if the sheet is later edited.
export async function buildSnapshot(sheetId: string): Promise<SnapshotSlot[]> {
  const { data: answers, error: aErr } = await db
    .from("perfect_sheet_answers")
    .select("id, canonical_player_key, display_name, sort_order, metadata")
    .eq("sheet_id", sheetId)
    .order("sort_order", { ascending: true });
  if (aErr) throw aErr;

  const ids = (answers ?? []).map((a) => a.id);
  const { data: aliases, error: alErr } = await db
    .from("perfect_sheet_answer_aliases")
    .select("answer_id, alias, alias_normalized")
    .in("answer_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  if (alErr) throw alErr;

  const byAnswer = new Map<string, Set<string>>();
  for (const a of answers ?? []) {
    // seed accepted with the display name itself
    byAnswer.set(a.id, new Set<string>([normalize(a.display_name)]));
  }
  for (const al of aliases ?? []) {
    const set = byAnswer.get(al.answer_id);
    if (!set) continue;
    if (al.alias_normalized) set.add(al.alias_normalized);
    if (al.alias) set.add(normalize(al.alias));
  }

  return (answers ?? []).map((a) => ({
    slot: a.sort_order,
    display_name: a.display_name,
    canonical_key: a.canonical_player_key,
    context_label: (a.metadata as Record<string, unknown>)?.context_label as
      | string
      | null ?? null,
    accepted: Array.from(byAnswer.get(a.id) ?? []).filter(Boolean),
  }));
}

// Reveal list (display names + context) — safe to send once a player's own
// game is over. Never includes opponent data.
// On a wrong guess, look up the guessed player's value + all-time rank for this
// category's metric (via the mp_player_metric_rank SQL fn), so the strike can
// show e.g. "2,137 BLK, #14 all-time". Player categories only; null otherwise.
export async function strikeContext(challenge: any, rawGuess: string) {
  try {
    const { data: sheet } = await db
      .from("perfect_sheets").select("source_params")
      .eq("id", challenge.sheet_id).single();
    const metric = (sheet?.source_params as Record<string, unknown> | null)?.metric as string | undefined;
    if (!metric || metric === "arenacapacity") return null;
    const { data, error } = await db.rpc("mp_player_metric_rank", { p_query: rawGuess, p_metric: metric });
    if (error || !data || !data.length) return null;
    const r = data[0];
    return {
      display_name: r.display_name,
      value: Number(r.value),
      rank: Number(r.rank),
      total: Number(r.total),
      unit: r.unit,
    };
  } catch {
    return null;
  }
}

export function revealedAnswers(snapshot: SnapshotSlot[]) {
  return snapshot
    .slice()
    .sort((x, y) => x.slot - y.slot)
    .map((s) => ({
      slot: s.slot,
      display_name: s.display_name,
      context_label: s.context_label,
    }));
}

// Head-to-head / per-challenge ordering:
//  1) finishers (completed) before non-finishers
//  2) finishers: faster ranking_time first
//  3) non-finishers: more correct first, then faster time-to-that-score
export function rankCompare(a: any, b: any): number {
  const ac = a.status === "completed" ? 1 : 0;
  const bc = b.status === "completed" ? 1 : 0;
  if (ac !== bc) return bc - ac;
  if (ac === 1) {
    return (a.ranking_time_ms ?? 1e15) - (b.ranking_time_ms ?? 1e15);
  }
  if ((b.correct_count ?? 0) !== (a.correct_count ?? 0)) {
    return (b.correct_count ?? 0) - (a.correct_count ?? 0);
  }
  return (a.ranking_time_ms ?? 1e15) - (b.ranking_time_ms ?? 1e15);
}

// Global leaderboard ordering: completions ranked by *completion time* first,
// then everyone else by correct count and time-to-score.
export function leaderboardCompare(a: any, b: any): number {
  const ac = a.status === "completed" ? 1 : 0;
  const bc = b.status === "completed" ? 1 : 0;
  if (ac !== bc) return bc - ac;
  if (ac === 1) return (a.elapsed_ms ?? 1e15) - (b.elapsed_ms ?? 1e15);
  if ((b.correct_count ?? 0) !== (a.correct_count ?? 0)) {
    return (b.correct_count ?? 0) - (a.correct_count ?? 0);
  }
  return (a.ranking_time_ms ?? 1e15) - (b.ranking_time_ms ?? 1e15);
}

export const isBotClient = (cid: string | null) => !!cid && cid.startsWith("bot_");

// Typeahead pools. These are the *whole universe* of guessable entities for a
// category type (all notable players / all current arenas), NOT the answer set —
// so the dropdown is only a typing aid and never reveals which names are correct.
// Arenas are a fixed list (from nba_raw.team_details); players come live from the
// public career-summary view so the pool tracks the data.
export const ARENA_POOL: { l: string; v: string }[] = [
  { l: "United Center — Bulls, Chicago", v: "United Center" },
  { l: "Rocket Mortgage FieldHouse — Cavaliers, Cleveland", v: "Rocket Mortgage FieldHouse" },
  { l: "Moda Center — Trail Blazers, Portland", v: "Moda Center" },
  { l: "Madison Square Garden — Knicks, New York", v: "Madison Square Garden" },
  { l: "Kaseya Center — Heat, Miami", v: "Kaseya Center" },
  { l: "Target Center — Timberwolves, Minnesota", v: "Target Center" },
  { l: "American Airlines Center — Mavericks, Dallas", v: "American Airlines Center" },
  { l: "Crypto.com Arena — Lakers/Clippers, Los Angeles", v: "Crypto.com Arena" },
  { l: "TD Garden — Celtics, Boston", v: "TD Garden" },
  { l: "State Farm Arena — Hawks, Atlanta", v: "State Farm Arena" },
  { l: "Gainbridge Fieldhouse — Pacers, Indiana", v: "Gainbridge Fieldhouse" },
  { l: "Wells Fargo Center — 76ers, Philadelphia", v: "Wells Fargo Center" },
  { l: "Fiserv Forum — Bucks, Milwaukee", v: "Fiserv Forum" },
  { l: "FedExForum — Grizzlies, Memphis", v: "FedExForum" },
  { l: "Delta Center — Jazz, Utah", v: "Delta Center" },
  { l: "Golden 1 Center — Kings, Sacramento", v: "Golden 1 Center" },
  { l: "Amway Center — Magic, Orlando", v: "Amway Center" },
  { l: "Barclays Center — Nets, Brooklyn", v: "Barclays Center" },
  { l: "Ball Arena — Nuggets, Denver", v: "Ball Arena" },
  { l: "Smoothie King Center — Pelicans, New Orleans", v: "Smoothie King Center" },
  { l: "Little Caesars Arena — Pistons, Detroit", v: "Little Caesars Arena" },
  { l: "Scotiabank Arena — Raptors, Toronto", v: "Scotiabank Arena" },
  { l: "Toyota Center — Rockets, Houston", v: "Toyota Center" },
  { l: "Footprint Center — Suns, Phoenix", v: "Footprint Center" },
  { l: "Paycom Center — Thunder, Oklahoma City", v: "Paycom Center" },
  { l: "Chase Center — Warriors, Golden State", v: "Chase Center" },
];

// Team autocomplete pool for subjective "team" lists (all 30 franchises).
export const TEAM_POOL: { l: string; v: string }[] = [
  "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets","Chicago Bulls",
  "Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets","Detroit Pistons","Golden State Warriors",
  "Houston Rockets","Indiana Pacers","Los Angeles Clippers","Los Angeles Lakers","Memphis Grizzlies",
  "Miami Heat","Milwaukee Bucks","Minnesota Timberwolves","New Orleans Pelicans","New York Knicks",
  "Oklahoma City Thunder","Orlando Magic","Philadelphia 76ers","Phoenix Suns","Portland Trail Blazers",
  "Sacramento Kings","San Antonio Spurs","Toronto Raptors","Utah Jazz","Washington Wizards",
].map((n) => ({ l: n, v: n }));

// Tier-list candidate pools.
export const CHAMPION_TEAMS = [
  "Boston Celtics","Los Angeles Lakers","Golden State Warriors","Chicago Bulls","San Antonio Spurs",
  "Philadelphia 76ers","Detroit Pistons","Miami Heat","Houston Rockets","Milwaukee Bucks",
  "New York Knicks","Denver Nuggets","Cleveland Cavaliers","Toronto Raptors","Dallas Mavericks",
  "Sacramento Kings","Atlanta Hawks","Washington Wizards","Oklahoma City Thunder","Portland Trail Blazers",
];
export const NOTABLE_COACHES = [
  "Phil Jackson","Gregg Popovich","Pat Riley","Red Auerbach","Steve Kerr","Erik Spoelstra","Doc Rivers",
  "Rick Carlisle","Larry Brown","Jerry Sloan","Don Nelson","Chuck Daly","Lenny Wilkens","Mike D'Antoni",
  "Tom Thibodeau","Mike Budenholzer","Tyronn Lue","Nick Nurse","Michael Malone","Frank Vogel","George Karl",
  "Rick Adelman","Mike Brown","Dwane Casey","Billy Donovan","Monty Williams","Quin Snyder","Scott Brooks",
  "Nate McMillan","Mark Jackson",
];
export const POOL_TYPE: Record<string, string> = { star_players: "player", all_teams: "team", champion_teams: "team", notable_coaches: "coach" };
export async function tierPool(source: string, era?: number | null): Promise<{ key: string; label: string }[]> {
  const mk = (arr: string[]) => arr.map((n) => ({ key: normalize(n), label: n }));
  if (source === "all_teams") return mk(TEAM_POOL.map((t) => t.v));
  if (source === "champion_teams") return mk(CHAMPION_TEAMS);
  if (source === "notable_coaches") return mk(NOTABLE_COACHES);
  // star_players: draw from a notability-ranked pool (stars + memorable role players +
  // surviving legends, with a built-in recency lean) so tier sets are recognizable and
  // debatable — not just the top career scorers.
  let q = db.from("mp_player_notability").select("player_name, notability");
  if (typeof era === "number" && Number.isFinite(era)) {
    // players who *played in* the decade (career overlaps it), recognizable enough to debate
    q = q.lte("first_season", era + 9).gte("last_season", era).gte("notability", 20).order("notability", { ascending: false }).limit(180);
  } else {
    q = q.order("notability", { ascending: false }).limit(160);
  }
  const { data } = await q;
  const seen = new Set<string>(); const out: { key: string; label: string }[] = [];
  for (const r of data ?? []) { const k = normalize(r.player_name); if (r.player_name && !seen.has(k)) { seen.add(k); out.push({ key: k, label: r.player_name }); } }
  return out;
}
export function drawSet<T>(pool: T[], n: number): T[] {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(n, a.length));
}
// Rotating daily tier debate (one shared set per calendar day).
export const DAILY_ROTATION = [
  { prompt: "Daily 1-on-1: tier these players", pool_source: "star_players", draw_size: 10 },
  { prompt: "Daily franchises: tier these teams", pool_source: "champion_teams", draw_size: 10 },
  { prompt: "Daily sidelines: tier these coaches", pool_source: "notable_coaches", draw_size: 8 },
  { prompt: "Daily hoopers: tier these legends", pool_source: "star_players", draw_size: 12 },
  { prompt: "Daily dynasties: tier these teams", pool_source: "all_teams", draw_size: 10 },
];

// ---------------------------------------------------------------------------
// Computer opponent. Simulates an attempt against the frozen snapshot: knows
// each answer with a difficulty-dependent probability, fills what it knows at
// randomized human-like speeds, and either completes or strikes out. Timing is
// still server-real (finished a few seconds "ago"), so it slots straight into
// the same ranking + head-to-head logic as a human.
export const BOT_PRESETS: Record<string, {p:number;min:number;max:number;label:string}> = {
  easy:   { p: 0.60, min: 4000, max: 11000, label: "Rookie" },
  medium: { p: 0.78, min: 3000, max: 7000,  label: "Starter" },
  hard:   { p: 0.92, min: 1800, max: 4500,  label: "All-Star" },
};

export function simulateBot(snapshot: SnapshotSlot[], target: number, strikeLimit: number, difficulty: string) {
  const cfg = BOT_PRESETS[difficulty] ?? BOT_PRESETS.medium;
  const rt = (n: number) => Math.floor(Math.random() * n);
  const order = snapshot.slice().sort(() => Math.random() - 0.5);
  let known = order.filter(() => Math.random() < cfg.p);
  if (known.length === 0) known = [order[0]];           // always know at least one

  const filled: Record<string, unknown> = {};
  const guesses: any[] = [];
  let t = 0, correct = 0, lastCorrect = 0;
  for (const s of known) {
    if (correct >= target) break;
    t += cfg.min + rt(cfg.max - cfg.min);
    filled[String(s.slot)] = { name: s.display_name, at_ms: t };
    guesses.push({ seq: guesses.length + 1, at_ms: t, raw: s.display_name, normalized: s.accepted[0] ?? "", result: "correct", slot: s.slot });
    correct++; lastCorrect = t;
  }

  let status: string, strikes: number, rankingTime: number, elapsed: number;
  if (correct >= target) {
    status = "completed"; strikes = Math.random() < 0.5 ? 0 : 1; rankingTime = t; elapsed = t;
  } else {
    status = "eliminated"; strikes = strikeLimit; rankingTime = lastCorrect;
    let st = t;
    for (let i = 0; i < strikeLimit; i++) {
      st += cfg.min + rt(cfg.max - cfg.min);
      guesses.push({ seq: guesses.length + 1, at_ms: st, raw: "(guess)", normalized: "", result: "strike", slot: null });
    }
    elapsed = st;
  }
  const now = Date.now();
  return {
    label: cfg.label,
    correct_count: correct, strikes, status,
    filled_slots: filled, guesses,
    started_at: new Date(now - elapsed).toISOString(),
    last_correct_at: new Date(now - elapsed + lastCorrect).toISOString(),
    finished_at: new Date(now).toISOString(),
    elapsed_ms: elapsed, ranking_time_ms: rankingTime,
  };
}

export async function insertBot(challengeId: string, mode: string, snapshot: SnapshotSlot[],
                         target: number, strikeLimit: number, difficulty: string) {
  const sim = simulateBot(snapshot, target, strikeLimit, difficulty);
  await db.from("mp_attempts").insert({
    challenge_id: challengeId,
    role: mode === "duel" ? "opponent" : "participant",
    player_client_id: "bot_" + randomToken(6),
    player_label: `Computer (${sim.label})`,
    status: sim.status,
    correct_count: sim.correct_count,
    strikes: sim.strikes,
    filled_slots: sim.filled_slots,
    guesses: sim.guesses,
    started_at: sim.started_at,
    finished_at: sim.finished_at,
    last_correct_at: sim.last_correct_at,
    elapsed_ms: sim.elapsed_ms,
    ranking_time_ms: sim.ranking_time_ms,
  });
  return sim.label;
}

// ---------------------------------------------------------------------------
// Roster-filter game ("name N of a large pool matching a filter").
// ---------------------------------------------------------------------------
export type PoolEntry = { player_key: string; display_name: string; accepted: string[]; rarity_tier: string; rarity_score: number | null };
export const RARITY_LABEL: Record<string, string> = { common: "Common", uncommon: "Uncommon", rare: "Rare", deep_cut: "Deep cut" };

// Reveal a slice of the pool (most famous first) as {slot, display_name, context_label}
// so the existing reveal UI renders it. context_label carries the rarity tier.
export function rosterReveal(pool: PoolEntry[], limit = 24) {
  return pool.slice()
    .sort((a, b) => (b.rarity_score ?? 0) - (a.rarity_score ?? 0))
    .slice(0, limit)
    .map((p, i) => ({ slot: i + 1, display_name: p.display_name, context_label: RARITY_LABEL[p.rarity_tier] ?? p.rarity_tier }));
}

// Computer opponent for roster: knows famous pool members with prob p.
export function simulateRosterBot(pool: PoolEntry[], target: number, strikeLimit: number, difficulty: string) {
  const cfg = BOT_PRESETS[difficulty] ?? BOT_PRESETS.medium;
  const rt = (n: number) => Math.floor(Math.random() * n);
  const ranked = pool.slice().sort((a, b) => (b.rarity_score ?? 0) - (a.rarity_score ?? 0));
  const known: PoolEntry[] = [];
  for (const p of ranked) { if (known.length >= target) break; if (Math.random() < cfg.p) known.push(p); }
  const filled: Record<string, unknown> = {};
  let t = 0, correct = 0, lastCorrect = 0;
  for (const p of known) {
    if (correct >= target) break;
    t += cfg.min + rt(cfg.max - cfg.min);
    filled[String(correct + 1)] = { name: p.display_name, player_key: p.player_key, at_ms: t, rarity_tier: p.rarity_tier };
    correct++; lastCorrect = t;
  }
  let status: string, strikes: number, rankingTime: number, elapsed: number;
  if (correct >= target) { status = "completed"; strikes = Math.random() < 0.5 ? 0 : 1; rankingTime = t; elapsed = t; }
  else { status = "eliminated"; strikes = strikeLimit; rankingTime = lastCorrect; let st = t; for (let i = 0; i < strikeLimit; i++) st += cfg.min + rt(cfg.max - cfg.min); elapsed = st; }
  const now = Date.now();
  return { label: cfg.label, correct_count: correct, strikes, status, filled_slots: filled, guesses: [],
    started_at: new Date(now - elapsed).toISOString(), last_correct_at: new Date(now - elapsed + lastCorrect).toISOString(),
    finished_at: new Date(now).toISOString(), elapsed_ms: elapsed, ranking_time_ms: rankingTime };
}

export async function insertRosterBot(challengeId: string, mode: string, pool: PoolEntry[], target: number, strikeLimit: number, difficulty: string) {
  const sim = simulateRosterBot(pool, target, strikeLimit, difficulty);
  await db.from("mp_attempts").insert({
    challenge_id: challengeId, role: mode === "duel" ? "opponent" : "participant",
    player_client_id: "bot_" + randomToken(6), player_label: `Computer (${sim.label})`,
    status: sim.status, correct_count: sim.correct_count, strikes: sim.strikes, filled_slots: sim.filled_slots, guesses: sim.guesses,
    started_at: sim.started_at, finished_at: sim.finished_at, last_correct_at: sim.last_correct_at, elapsed_ms: sim.elapsed_ms, ranking_time_ms: sim.ranking_time_ms,
  });
  return sim.label;
}

// Find the pool entry a normalized guess matches, or null. Shared by the roster
// game and Pickup so "is this a valid name" has exactly one definition.
// Builds a Map per call: pools run to a few hundred entries with several aliases
// each, and the party path hits this on every keystroke-submit from every phone.
export function matchPoolGuess(pool: PoolEntry[], norm: string): PoolEntry | null {
  if (!norm) return null;
  const byAlias = new Map<string, PoolEntry>();
  for (const p of pool) {
    for (const a of p.accepted) if (!byAlias.has(a)) byAlias.set(a, p);
  }
  return byAlias.get(norm) ?? null;
}

export async function loadRosterPool(rosterSheetId: string): Promise<PoolEntry[]> {
  const { data } = await db.from("mp_roster_pool")
    .select("player_key, display_name, accepted, rarity_tier, rarity_score")
    .eq("sheet_id", rosterSheetId);
  return (data ?? []).map((p) => ({
    player_key: p.player_key, display_name: p.display_name,
    accepted: (p.accepted ?? []) as string[], rarity_tier: p.rarity_tier, rarity_score: p.rarity_score,
  }));
}

