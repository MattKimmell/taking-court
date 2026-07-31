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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
const ok = (b: Record<string, unknown> = {}) => json({ ok: true, ...b });
const err = (msg: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error: msg, ...extra }, status);

// Name normalizer — must stay in sync with public.mp_normalize in SQL:
// accent-fold, lowercase, keep alphanumerics only.
function normalize(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function randomToken(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Pull an authenticated user id out of the caller's JWT, if present.
// The public anon key has role "anon" (=> no user). A logged-in Supabase user
// token has role "authenticated" and sub = user id.
function authedUserId(req: Request): string | null {
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

type SnapshotSlot = {
  slot: number;
  display_name: string;
  canonical_key: string;
  context_label: string | null;
  accepted: string[]; // normalized accepted aliases
};

// Build the frozen answer snapshot for a sheet from perfect_sheet_answers +
// aliases. This is stored on the challenge so the game is reproducible and the
// answer set is fixed even if the sheet is later edited.
async function buildSnapshot(sheetId: string): Promise<SnapshotSlot[]> {
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
async function strikeContext(challenge: any, rawGuess: string) {
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

function revealedAnswers(snapshot: SnapshotSlot[]) {
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
function rankCompare(a: any, b: any): number {
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
function leaderboardCompare(a: any, b: any): number {
  const ac = a.status === "completed" ? 1 : 0;
  const bc = b.status === "completed" ? 1 : 0;
  if (ac !== bc) return bc - ac;
  if (ac === 1) return (a.elapsed_ms ?? 1e15) - (b.elapsed_ms ?? 1e15);
  if ((b.correct_count ?? 0) !== (a.correct_count ?? 0)) {
    return (b.correct_count ?? 0) - (a.correct_count ?? 0);
  }
  return (a.ranking_time_ms ?? 1e15) - (b.ranking_time_ms ?? 1e15);
}

const isBotClient = (cid: string | null) => !!cid && cid.startsWith("bot_");

// Typeahead pools. These are the *whole universe* of guessable entities for a
// category type (all notable players / all current arenas), NOT the answer set —
// so the dropdown is only a typing aid and never reveals which names are correct.
// Arenas are a fixed list (from nba_raw.team_details); players come live from the
// public career-summary view so the pool tracks the data.
const ARENA_POOL: { l: string; v: string }[] = [
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
const TEAM_POOL: { l: string; v: string }[] = [
  "Atlanta Hawks","Boston Celtics","Brooklyn Nets","Charlotte Hornets","Chicago Bulls",
  "Cleveland Cavaliers","Dallas Mavericks","Denver Nuggets","Detroit Pistons","Golden State Warriors",
  "Houston Rockets","Indiana Pacers","Los Angeles Clippers","Los Angeles Lakers","Memphis Grizzlies",
  "Miami Heat","Milwaukee Bucks","Minnesota Timberwolves","New Orleans Pelicans","New York Knicks",
  "Oklahoma City Thunder","Orlando Magic","Philadelphia 76ers","Phoenix Suns","Portland Trail Blazers",
  "Sacramento Kings","San Antonio Spurs","Toronto Raptors","Utah Jazz","Washington Wizards",
].map((n) => ({ l: n, v: n }));

// Tier-list candidate pools.
const CHAMPION_TEAMS = [
  "Boston Celtics","Los Angeles Lakers","Golden State Warriors","Chicago Bulls","San Antonio Spurs",
  "Philadelphia 76ers","Detroit Pistons","Miami Heat","Houston Rockets","Milwaukee Bucks",
  "New York Knicks","Denver Nuggets","Cleveland Cavaliers","Toronto Raptors","Dallas Mavericks",
  "Sacramento Kings","Atlanta Hawks","Washington Wizards","Oklahoma City Thunder","Portland Trail Blazers",
];
const NOTABLE_COACHES = [
  "Phil Jackson","Gregg Popovich","Pat Riley","Red Auerbach","Steve Kerr","Erik Spoelstra","Doc Rivers",
  "Rick Carlisle","Larry Brown","Jerry Sloan","Don Nelson","Chuck Daly","Lenny Wilkens","Mike D'Antoni",
  "Tom Thibodeau","Mike Budenholzer","Tyronn Lue","Nick Nurse","Michael Malone","Frank Vogel","George Karl",
  "Rick Adelman","Mike Brown","Dwane Casey","Billy Donovan","Monty Williams","Quin Snyder","Scott Brooks",
  "Nate McMillan","Mark Jackson",
];
const POOL_TYPE: Record<string, string> = { star_players: "player", all_teams: "team", champion_teams: "team", notable_coaches: "coach" };
async function tierPool(source: string, era?: number | null): Promise<{ key: string; label: string }[]> {
  const mk = (arr: string[]) => arr.map((n) => ({ key: normalize(n), label: n }));
  if (source === "all_teams") return mk(TEAM_POOL.map((t) => t.v));
  if (source === "champion_teams") return mk(CHAMPION_TEAMS);
  if (source === "notable_coaches") return mk(NOTABLE_COACHES);
  let q = db.from("vw_trivia_player_career_summary").select("player_name, career_points").eq("season_type", "REGULAR");
  if (typeof era === "number" && Number.isFinite(era)) {
    // players who *played in* the decade (career overlaps it), filtered to recognizable
    q = q.lte("first_season", era + 9).gte("last_season", era).gte("career_points", 8000).order("career_points", { ascending: false }).limit(150);
  } else {
    q = q.order("career_points", { ascending: false }).limit(90);
  }
  const { data } = await q;
  const seen = new Set<string>(); const out: { key: string; label: string }[] = [];
  for (const r of data ?? []) { const k = normalize(r.player_name); if (r.player_name && !seen.has(k)) { seen.add(k); out.push({ key: k, label: r.player_name }); } }
  return out;
}
function drawSet<T>(pool: T[], n: number): T[] {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(n, a.length));
}
// Rotating daily tier debate (one shared set per calendar day).
const DAILY_ROTATION = [
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
const BOT_PRESETS: Record<string, {p:number;min:number;max:number;label:string}> = {
  easy:   { p: 0.60, min: 4000, max: 11000, label: "Rookie" },
  medium: { p: 0.78, min: 3000, max: 7000,  label: "Starter" },
  hard:   { p: 0.92, min: 1800, max: 4500,  label: "All-Star" },
};

function simulateBot(snapshot: SnapshotSlot[], target: number, strikeLimit: number, difficulty: string) {
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

async function insertBot(challengeId: string, mode: string, snapshot: SnapshotSlot[],
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
type PoolEntry = { player_key: string; display_name: string; accepted: string[]; rarity_tier: string; rarity_score: number | null };
const RARITY_LABEL: Record<string, string> = { common: "Common", uncommon: "Uncommon", rare: "Rare", deep_cut: "Deep cut" };

// Reveal a slice of the pool (most famous first) as {slot, display_name, context_label}
// so the existing reveal UI renders it. context_label carries the rarity tier.
function rosterReveal(pool: PoolEntry[], limit = 24) {
  return pool.slice()
    .sort((a, b) => (b.rarity_score ?? 0) - (a.rarity_score ?? 0))
    .slice(0, limit)
    .map((p, i) => ({ slot: i + 1, display_name: p.display_name, context_label: RARITY_LABEL[p.rarity_tier] ?? p.rarity_tier }));
}

// Computer opponent for roster: knows famous pool members with prob p.
function simulateRosterBot(pool: PoolEntry[], target: number, strikeLimit: number, difficulty: string) {
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

async function insertRosterBot(challengeId: string, mode: string, pool: PoolEntry[], target: number, strikeLimit: number, difficulty: string) {
  const sim = simulateRosterBot(pool, target, strikeLimit, difficulty);
  await db.from("mp_attempts").insert({
    challenge_id: challengeId, role: mode === "duel" ? "opponent" : "participant",
    player_client_id: "bot_" + randomToken(6), player_label: `Computer (${sim.label})`,
    status: sim.status, correct_count: sim.correct_count, strikes: sim.strikes, filled_slots: sim.filled_slots, guesses: sim.guesses,
    started_at: sim.started_at, finished_at: sim.finished_at, last_correct_at: sim.last_correct_at, elapsed_ms: sim.elapsed_ms, ranking_time_ms: sim.ranking_time_ms,
  });
  return sim.label;
}

async function loadRosterPool(rosterSheetId: string): Promise<PoolEntry[]> {
  const { data } = await db.from("mp_roster_pool")
    .select("player_key, display_name, accepted, rarity_tier, rarity_score")
    .eq("sheet_id", rosterSheetId);
  return (data ?? []).map((p) => ({
    player_key: p.player_key, display_name: p.display_name,
    accepted: (p.accepted ?? []) as string[], rarity_tier: p.rarity_tier, rarity_score: p.rarity_score,
  }));
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

async function actionSheets() {
  const { data, error } = await db
    .from("perfect_sheets")
    .select("id, prompt, difficulty, answer_count, source_kind")
    .eq("status", "approved")
    .eq("answer_count", 8)
    .order("difficulty", { ascending: true });
  if (error) return err(error.message, 500);
  const top8 = (data ?? []).map((s) => ({ id: s.id, kind: "top8", prompt: s.prompt, difficulty: s.difficulty, answer_target: s.answer_count }));

  const { data: rosters } = await db
    .from("mp_roster_sheets")
    .select("id, prompt, difficulty, target")
    .eq("status", "approved")
    .order("difficulty", { ascending: true });
  const roster = (rosters ?? []).map((s) => ({ id: s.id, kind: "roster", prompt: s.prompt, difficulty: s.difficulty, answer_target: s.target }));

  return ok({ sheets: [...top8, ...roster] });
}

// Create a roster challenge: freeze the eligible pool + rarity, target = "name N".
async function actionCreateRoster(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const mode = body.mode === "competition" ? "competition" : "duel";

  let rid: string | null = body.sheet_id ?? null;
  if (!rid) {
    const { data: pool } = await db.from("mp_roster_sheets").select("id").eq("status", "approved");
    if (!pool || pool.length === 0) return err("no_categories_available", 404);
    rid = pool[Math.floor(Math.random() * pool.length)].id;
  }
  const { data: sheet, error: sErr } = await db.from("mp_roster_sheets").select("id, prompt, target").eq("id", rid).single();
  if (sErr || !sheet) return err("category_not_found", 404);

  const pool = await loadRosterPool(sheet.id);
  if (pool.length < sheet.target) return err("category_incomplete", 500);

  const strikeLimit = Number.isFinite(body.strike_limit) ? Math.max(1, Math.floor(body.strike_limit)) : 3;
  const requireAuth = body.require_auth === true;
  const expiresDays = Number.isFinite(body.expires_in_days) ? Math.max(1, Math.floor(body.expires_in_days)) : 30;
  const maxParticipants = mode === "duel" ? 2 : (Number.isFinite(body.max_participants) ? Math.max(2, Math.floor(body.max_participants)) : null);
  if (requireAuth && !userId) return err("auth_required_for_this_challenge", 401);

  const shareToken = randomToken(9);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresDays * 86400000);

  const { data: challenge, error: cErr } = await db.from("mp_challenges").insert({
    share_token: shareToken, kind: "roster", roster_sheet_id: sheet.id, sheet_id: null, mode, status: "open",
    prompt: sheet.prompt, answer_target: sheet.target, question_version: 1, answers_snapshot: pool,
    strike_limit: strikeLimit, rules: { strike_limit: strikeLimit, answer_target: sheet.target, mode, kind: "roster" },
    max_participants: maxParticipants, require_auth: requireAuth,
    creator_client_id: clientId, creator_user_id: userId, creator_label: body.label ?? "Player A", expires_at: expiresAt.toISOString(),
  }).select("id, share_token, prompt, answer_target, strike_limit, mode, expires_at").single();
  if (cErr) return err(cErr.message, 500);

  const { data: attempt, error: atErr } = await db.from("mp_attempts").insert({
    challenge_id: challenge.id, role: "creator", player_client_id: clientId, player_user_id: userId, player_label: body.label ?? "Player A",
  }).select("id, attempt_token").single();
  if (atErr) return err(atErr.message, 500);

  let botLabel: string | null = null;
  if (body.vs === "computer") {
    const diff = ["easy", "medium", "hard"].includes(body.bot_difficulty) ? body.bot_difficulty : "medium";
    botLabel = await insertRosterBot(challenge.id, challenge.mode, pool, challenge.answer_target, strikeLimit, diff);
  }

  return ok({
    challenge_id: challenge.id, share_token: challenge.share_token, attempt_id: attempt.id, attempt_token: attempt.attempt_token,
    prompt: challenge.prompt, answer_target: challenge.answer_target, strike_limit: challenge.strike_limit, mode: challenge.mode,
    kind: "roster", expires_at: challenge.expires_at, has_bot: !!botLabel, bot_label: botLabel,
  });
}

async function actionCreate(req: Request, body: any) {
  if (body.kind === "roster") return await actionCreateRoster(req, body);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) {
    return err("identity_required: pass client_id or authenticate", 400);
  }
  const mode = body.mode === "competition" ? "competition" : "duel";

  // choose category
  let sheetId: string | null = body.sheet_id ?? null;
  if (!sheetId) {
    const { data: pool } = await db
      .from("perfect_sheets")
      .select("id")
      .eq("status", "approved")
      .eq("answer_count", 8);
    if (!pool || pool.length === 0) return err("no_categories_available", 404);
    sheetId = pool[Math.floor(Math.random() * pool.length)].id;
  }

  const { data: sheet, error: sErr } = await db
    .from("perfect_sheets")
    .select("id, prompt, answer_count, source_as_of")
    .eq("id", sheetId)
    .single();
  if (sErr || !sheet) return err("category_not_found", 404);

  const snapshot = await buildSnapshot(sheet.id);
  if (snapshot.length !== sheet.answer_count) {
    return err("category_incomplete", 500);
  }

  const strikeLimit = Number.isFinite(body.strike_limit)
    ? Math.max(1, Math.floor(body.strike_limit))
    : 3;
  const requireAuth = body.require_auth === true;
  const expiresDays = Number.isFinite(body.expires_in_days)
    ? Math.max(1, Math.floor(body.expires_in_days))
    : 30;
  const maxParticipants =
    mode === "duel" ? 2 : (Number.isFinite(body.max_participants)
      ? Math.max(2, Math.floor(body.max_participants))
      : null);

  if (requireAuth && !userId) {
    return err("auth_required_for_this_challenge", 401);
  }

  const shareToken = randomToken(9);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresDays * 86400000);

  const { data: challenge, error: cErr } = await db
    .from("mp_challenges")
    .insert({
      share_token: shareToken,
      sheet_id: sheet.id,
      mode,
      status: "open",
      prompt: sheet.prompt,
      answer_target: sheet.answer_count,
      question_version: 1,
      answers_snapshot: snapshot,
      source_data_asof: sheet.source_as_of ?? null,
      strike_limit: strikeLimit,
      rules: { strike_limit: strikeLimit, answer_target: sheet.answer_count, mode },
      max_participants: maxParticipants,
      require_auth: requireAuth,
      creator_client_id: clientId,
      creator_user_id: userId,
      creator_label: body.label ?? "Player A",
      expires_at: expiresAt.toISOString(),
    })
    .select("id, share_token, prompt, answer_target, strike_limit, mode, expires_at")
    .single();
  if (cErr) return err(cErr.message, 500);

  // creator's own attempt (timer not started until they reveal / first guess)
  const { data: attempt, error: atErr } = await db
    .from("mp_attempts")
    .insert({
      challenge_id: challenge.id,
      role: "creator",
      player_client_id: clientId,
      player_user_id: userId,
      player_label: body.label ?? "Player A",
    })
    .select("id, attempt_token")
    .single();
  if (atErr) return err(atErr.message, 500);

  // Optional computer opponent. Its result stays hidden from the creator until
  // they finish (revealed only through `results`), so no information leaks here.
  let botLabel: string | null = null;
  if (body.vs === "computer") {
    const diff = ["easy", "medium", "hard"].includes(body.bot_difficulty) ? body.bot_difficulty : "medium";
    botLabel = await insertBot(challenge.id, challenge.mode, snapshot, challenge.answer_target, strikeLimit, diff);
  }

  return ok({
    challenge_id: challenge.id,
    share_token: challenge.share_token,
    attempt_id: attempt.id,
    attempt_token: attempt.attempt_token,
    prompt: challenge.prompt,
    answer_target: challenge.answer_target,
    strike_limit: challenge.strike_limit,
    mode: challenge.mode,
    expires_at: challenge.expires_at,
    has_bot: !!botLabel,
    bot_label: botLabel,   // just the name/difficulty, never its score
  });
}

// Add a computer opponent to an existing challenge (e.g. from a rematch or if
// the human wants a bot to race). Returns only the label, never the bot result.
async function actionAddBot(_req: Request, body: any) {
  const { challenge, error: cErr } = await loadChallenge(body);
  if (cErr) return err(cErr, 404);
  const diff = ["easy", "medium", "hard"].includes(body.bot_difficulty) ? body.bot_difficulty : "medium";

  // respect duel capacity (bot takes a seat)
  const { data: attempts } = await db.from("mp_attempts").select("id").eq("challenge_id", challenge.id);
  if (challenge.max_participants != null && (attempts?.length ?? 0) >= challenge.max_participants) {
    return err("challenge_full", 409);
  }
  if (challenge.kind === "roster") {
    const pool = await loadRosterPool(challenge.roster_sheet_id);
    const rlabel = await insertRosterBot(challenge.id, challenge.mode, pool, challenge.answer_target, challenge.strike_limit, diff);
    return ok({ bot_added: true, bot_label: rlabel });
  }
  const label = await insertBot(
    challenge.id, challenge.mode, challenge.answers_snapshot as SnapshotSlot[],
    challenge.answer_target, challenge.strike_limit, diff,
  );
  return ok({ bot_added: true, bot_label: label });
}

async function loadChallenge(body: any) {
  let q = db.from("mp_challenges").select("*");
  if (body.challenge_id) q = q.eq("id", body.challenge_id);
  else if (body.share_token) q = q.eq("share_token", body.share_token);
  else return { challenge: null, error: "missing_challenge_ref" };
  const { data, error } = await q.single();
  if (error || !data) return { challenge: null, error: "challenge_not_found" };
  return { challenge: data, error: null };
}

async function actionOpen(req: Request, body: any) {
  const { challenge, error: cErr } = await loadChallenge(body);
  if (cErr) return err(cErr, 404);

  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;

  const { data: attempts } = await db
    .from("mp_attempts")
    .select("id, role, player_label, status, player_client_id, player_user_id, started_at")
    .eq("challenge_id", challenge.id);

  const started = (attempts ?? []).filter((a) => a.started_at);
  const mine = (attempts ?? []).find(
    (a) =>
      (userId && a.player_user_id === userId) ||
      (clientId && a.player_client_id === clientId),
  );

  return ok({
    challenge: {
      id: challenge.id,
      share_token: challenge.share_token,
      prompt: challenge.prompt,
      answer_target: challenge.answer_target,
      strike_limit: challenge.strike_limit,
      mode: challenge.mode,
      kind: challenge.kind ?? "top8",
      status: challenge.status,
      require_auth: challenge.require_auth,
      max_participants: challenge.max_participants,
      participant_count: started.length,
      expires_at: challenge.expires_at,
      expired: new Date(challenge.expires_at).getTime() < Date.now(),
    },
    // Only ever returns the *caller's own* attempt summary; never answers,
    // never other players.
    your_attempt: mine
      ? {
          id: mine.id,
          role: mine.role,
          status: mine.status,
          started: !!mine.started_at,
        }
      : null,
  });
}

async function actionStart(req: Request, body: any) {
  const { challenge, error: cErr } = await loadChallenge(body);
  if (cErr) return err(cErr, 404);

  if (challenge.status !== "open") return err("challenge_closed", 409);
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    return err("challenge_expired", 409);
  }

  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  if (challenge.require_auth && !userId) {
    return err("auth_required_for_this_challenge", 401);
  }

  const { data: attempts } = await db
    .from("mp_attempts")
    .select("id, attempt_token, role, status, started_at, correct_count, strikes, filled_slots, player_client_id, player_user_id")
    .eq("challenge_id", challenge.id);

  let mine = (attempts ?? []).find(
    (a) =>
      (userId && a.player_user_id === userId) ||
      (clientId && a.player_client_id === clientId),
  );

  // join if this identity has no attempt yet
  if (!mine) {
    const startedCount = (attempts ?? []).length;
    if (
      challenge.max_participants != null &&
      startedCount >= challenge.max_participants
    ) {
      return err("challenge_full", 409);
    }
    const role = challenge.mode === "duel" ? "opponent" : "participant";
    const { data: created, error: jErr } = await db
      .from("mp_attempts")
      .insert({
        challenge_id: challenge.id,
        role,
        player_client_id: clientId,
        player_user_id: userId,
        player_label: body.label ?? (role === "opponent" ? "Player B" : "Player"),
      })
      .select("id, attempt_token, role, status, started_at, correct_count, strikes, filled_slots")
      .single();
    if (jErr) {
      // unique-violation race: someone created it concurrently — refetch
      const { data: again } = await db
        .from("mp_attempts")
        .select("id, attempt_token, role, status, started_at, correct_count, strikes, filled_slots, player_client_id, player_user_id")
        .eq("challenge_id", challenge.id);
      mine = (again ?? []).find(
        (a) =>
          (userId && a.player_user_id === userId) ||
          (clientId && a.player_client_id === clientId),
      );
      if (!mine) return err(jErr.message, 500);
    } else {
      mine = created as any;
    }
  }

  // start the server clock (idempotent — never resets a running timer)
  if (!mine.started_at && mine.status === "in_progress") {
    const nowIso = new Date().toISOString();
    const { data: upd } = await db
      .from("mp_attempts")
      .update({ started_at: nowIso, updated_at: nowIso })
      .eq("id", mine.id)
      .is("started_at", null)
      .select("started_at")
      .single();
    if (upd) mine.started_at = upd.started_at;
    // also stamp the challenge's first-start, for reference
    if (!challenge.starts_at) {
      await db
        .from("mp_challenges")
        .update({ starts_at: nowIso })
        .eq("id", challenge.id)
        .is("starts_at", null);
    }
  }

  return ok({
    challenge_id: challenge.id,
    attempt_id: mine.id,
    attempt_token: mine.attempt_token,
    role: mine.role,
    prompt: challenge.prompt,
    answer_target: challenge.answer_target,
    strike_limit: challenge.strike_limit,
    mode: challenge.mode,
    kind: challenge.kind ?? "top8",
    status: mine.status,
    started_at: mine.started_at,
    correct_count: mine.correct_count ?? 0,
    strikes: mine.strikes ?? 0,
    filled_slots: mine.filled_slots ?? {},
  });
}

async function actionGuess(_req: Request, body: any) {
  const attemptId = body.attempt_id;
  const attemptToken = body.attempt_token;
  const rawGuess: string = body.guess ?? "";
  if (!attemptId || !attemptToken) return err("missing_attempt_credentials", 400);

  const { data: attempt, error: atErr } = await db
    .from("mp_attempts")
    .select("*")
    .eq("id", attemptId)
    .single();
  if (atErr || !attempt) return err("attempt_not_found", 404);
  if (attempt.attempt_token !== attemptToken) return err("bad_attempt_token", 403);

  const { data: challenge } = await db
    .from("mp_challenges")
    .select("*")
    .eq("id", attempt.challenge_id)
    .single();
  if (!challenge) return err("challenge_not_found", 404);

  const now = new Date();

  // expire mid-game if past deadline
  if (
    attempt.status === "in_progress" &&
    new Date(challenge.expires_at).getTime() < now.getTime()
  ) {
    const startedMs = attempt.started_at ? new Date(attempt.started_at).getTime() : now.getTime();
    const rankTime = attempt.last_correct_at
      ? new Date(attempt.last_correct_at).getTime() - startedMs
      : 0;
    await db.from("mp_attempts").update({
      status: "expired",
      finished_at: now.toISOString(),
      elapsed_ms: now.getTime() - startedMs,
      ranking_time_ms: rankTime,
      updated_at: now.toISOString(),
    }).eq("id", attempt.id);
    return err("challenge_expired", 409);
  }

  if (attempt.status !== "in_progress") {
    return ok({
      result: "already_finished",
      status: attempt.status,
      correct_count: attempt.correct_count,
      strikes: attempt.strikes,
      strikes_remaining: challenge.strike_limit - attempt.strikes,
      answer_target: challenge.answer_target,
      filled_slots: attempt.filled_slots,
      finished: true,
    });
  }

  // auto-start the clock on first guess if not already started
  let startedAt = attempt.started_at;
  if (!startedAt) {
    startedAt = now.toISOString();
  }
  const startedMs = new Date(startedAt).getTime();
  const atMs = now.getTime() - startedMs;

  const isRoster = challenge.kind === "roster";
  const snapshot = challenge.answers_snapshot as any[];
  const filled = { ...(attempt.filled_slots as Record<string, any>) };
  const guesses = [...(attempt.guesses as any[])];
  const norm = normalize(rawGuess);
  if (!norm) return err("empty_guess", 400);

  const priorNorms = new Set(guesses.map((g) => g.normalized));
  let correctCount = attempt.correct_count;
  let strikes = attempt.strikes;
  let lastCorrectAt = attempt.last_correct_at;
  let result: "correct" | "strike" | "duplicate" = "strike";
  let matchedSlot: number | null = null;
  let matchedName: string | null = null;
  let matchedContext: string | null = null;
  let rarityInfo: any = null;

  if (isRoster) {
    // pool game: any un-used pool member fills the next open slot (1..target)
    const usedKeys = new Set(Object.values(filled).map((f: any) => f.player_key));
    const hit = (snapshot as PoolEntry[]).find((p) => p.accepted.includes(norm));
    if (hit) {
      if (usedKeys.has(hit.player_key)) {
        result = "duplicate"; matchedName = hit.display_name;
      } else {
        result = "correct"; matchedName = hit.display_name;
        let slot = 1; while (filled[String(slot)]) slot++;
        matchedSlot = slot;
        matchedContext = RARITY_LABEL[hit.rarity_tier] ?? hit.rarity_tier;
        filled[String(slot)] = { name: hit.display_name, player_key: hit.player_key, at_ms: atMs, rarity_tier: hit.rarity_tier };
        correctCount += 1; lastCorrectAt = now.toISOString();
        // live crowd pick-rate (once enough games have been played)
        let pickPct: number | null = null;
        try {
          const { data: bp } = await db.rpc("mp_roster_bump_pick", { p_sheet: challenge.roster_sheet_id, p_player: hit.player_key });
          const rowp = Array.isArray(bp) ? bp[0] : bp;
          if (rowp && rowp.plays >= 15) pickPct = Math.max(1, Math.min(100, Math.round((rowp.picks * 100) / rowp.plays)));
        } catch { /* pick tracking is best-effort */ }
        rarityInfo = { rarity_tier: hit.rarity_tier, rarity_label: RARITY_LABEL[hit.rarity_tier] ?? hit.rarity_tier, pick_pct: pickPct };
      }
    } else {
      if (priorNorms.has(norm)) result = "duplicate";
      else { result = "strike"; strikes += 1; }
    }
  } else {
    const hit = (snapshot as SnapshotSlot[]).find((s) => s.accepted.includes(norm));
    if (hit) {
      if (filled[String(hit.slot)]) { result = "duplicate"; matchedSlot = hit.slot; matchedName = hit.display_name; }
      else {
        result = "correct"; matchedSlot = hit.slot; matchedName = hit.display_name; matchedContext = hit.context_label;
        filled[String(hit.slot)] = { name: hit.display_name, at_ms: atMs };
        correctCount += 1; lastCorrectAt = now.toISOString();
      }
    } else {
      if (priorNorms.has(norm)) result = "duplicate";
      else { result = "strike"; strikes += 1; }
    }
  }

  guesses.push({ seq: guesses.length + 1, at_ms: atMs, raw: rawGuess, normalized: norm, result, slot: matchedSlot });

  let status = attempt.status;
  let finishedAt: string | null = null;
  let elapsedMs: number | null = null;
  let rankingTimeMs: number | null = null;
  if (result === "correct" && correctCount >= challenge.answer_target) {
    status = "completed"; finishedAt = now.toISOString(); elapsedMs = atMs; rankingTimeMs = atMs;
  } else if (result === "strike" && strikes >= challenge.strike_limit) {
    status = "eliminated"; finishedAt = now.toISOString(); elapsedMs = atMs;
    rankingTimeMs = lastCorrectAt ? new Date(lastCorrectAt).getTime() - startedMs : 0;
  }

  const patch: Record<string, unknown> = {
    started_at: startedAt, correct_count: correctCount, strikes, filled_slots: filled, guesses,
    last_correct_at: lastCorrectAt, status, updated_at: now.toISOString(),
  };
  if (finishedAt) { patch.finished_at = finishedAt; patch.elapsed_ms = elapsedMs; patch.ranking_time_ms = rankingTimeMs; }
  const { error: uErr } = await db.from("mp_attempts").update(patch).eq("id", attempt.id);
  if (uErr) return err(uErr.message, 500);

  const finished = status !== "in_progress";
  if (isRoster && finished && challenge.roster_sheet_id) {
    try { await db.rpc("mp_roster_bump_play", { p_sheet: challenge.roster_sheet_id }); } catch { /* best-effort */ }
  }

  // near-miss context (top8 metric categories only)
  const guessInfo = (!isRoster && result === "strike") ? await strikeContext(challenge, rawGuess) : null;
  const reveal = finished ? (isRoster ? rosterReveal(snapshot as PoolEntry[]) : revealedAnswers(snapshot as SnapshotSlot[])) : undefined;

  return ok({
    result,
    slot: matchedSlot,
    display_name: result === "correct" ? matchedName : undefined,
    context_label: result === "correct" ? matchedContext : undefined,
    guess_info: guessInfo ?? undefined,
    rarity: rarityInfo ?? undefined,
    correct_count: correctCount,
    strikes,
    strikes_remaining: challenge.strike_limit - strikes,
    answer_target: challenge.answer_target,
    at_ms: atMs,
    filled_slots: filled,
    status,
    finished,
    elapsed_ms: elapsedMs ?? undefined,
    ranking_time_ms: rankingTimeMs ?? undefined,
    revealed_answers: reveal,
  });
}

async function actionResults(_req: Request, body: any) {
  const { challenge, error: cErr } = await loadChallenge(body);
  if (cErr) return err(cErr, 404);

  const { data: reqAttempt } = await db
    .from("mp_attempts")
    .select("*")
    .eq("id", body.attempt_id ?? "")
    .maybeSingle();
  if (!reqAttempt || reqAttempt.challenge_id !== challenge.id) {
    return err("attempt_not_found", 404);
  }
  if (reqAttempt.attempt_token !== (body.attempt_token ?? "")) {
    return err("bad_attempt_token", 403);
  }

  const challengeClosed =
    challenge.status === "closed" ||
    new Date(challenge.expires_at).getTime() < Date.now();
  const requesterFinished = reqAttempt.status !== "in_progress";

  // Suspense guard: you can't see anyone else's result until you're done
  // (or the whole challenge has closed).
  if (!requesterFinished && !challengeClosed) {
    return err("finish_first", 403, { your_status: reqAttempt.status });
  }

  const { data: allAttempts } = await db
    .from("mp_attempts")
    .select("*")
    .eq("challenge_id", challenge.id);

  const started = (allAttempts ?? []).filter((a) => a.started_at);
  const ranked = started.slice().sort(rankCompare);

  // persist ranks
  for (let i = 0; i < ranked.length; i++) {
    const wantRank = i + 1;
    if (ranked[i].rank !== wantRank) {
      await db.from("mp_attempts").update({ rank: wantRank }).eq("id", ranked[i].id);
      ranked[i].rank = wantRank;
    }
  }

  const allFinished =
    started.length > 0 && started.every((a) => a.status !== "in_progress");

  // winner: only declared when every started participant is finished
  let winner: { type: string; attempt_id?: string } = { type: "pending" };
  if (challengeClosed || allFinished) {
    if (ranked.length === 0) winner = { type: "none" };
    else if (ranked.length === 1) winner = { type: "attempt", attempt_id: ranked[0].id };
    else {
      const tie = rankCompare(ranked[0], ranked[1]) === 0;
      winner = tie ? { type: "draw" } : { type: "attempt", attempt_id: ranked[0].id };
    }
  }

  const snapshot = challenge.answers_snapshot as any[];
  const reveal = challenge.kind === "roster"
    ? rosterReveal(snapshot as PoolEntry[])
    : revealedAnswers(snapshot as SnapshotSlot[]);

  const participants = ranked.map((a) => {
    const isRequester = a.id === reqAttempt.id;
    const visible = isRequester || a.status !== "in_progress" || challengeClosed;
    if (!visible) {
      return {
        attempt_id: a.id,
        player_label: a.player_label,
        role: a.role,
        hidden: true,
        status: "in_progress",
      };
    }
    return {
      attempt_id: a.id,
      player_label: a.player_label,
      role: a.role,
      hidden: false,
      status: a.status,
      completed: a.status === "completed",
      correct_count: a.correct_count,
      strikes: a.strikes,
      strike_limit: challenge.strike_limit,
      elapsed_ms: a.elapsed_ms,
      ranking_time_ms: a.ranking_time_ms,
      rank: a.rank,
      is_you: isRequester,
    };
  });

  return ok({
    challenge_id: challenge.id,
    mode: challenge.mode,
    kind: challenge.kind ?? "top8",
    status: challenge.status,
    prompt: challenge.prompt,
    answer_target: challenge.answer_target,
    strike_limit: challenge.strike_limit,
    all_finished: allFinished,
    winner,
    participants,
    your_attempt_id: reqAttempt.id,
    revealed_answers: reveal,
  });
}

// Global / per-category leaderboard. Ranks finished attempts by completion then
// completion time. Only ever exposes finished attempts (never in-progress, so no
// live game is leaked), aggregate stats only (labels + times, never answers).
async function actionLeaderboard(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const includeBots = body.include_bots === true;
  const limit = Number.isFinite(body.limit) ? Math.min(100, Math.max(1, Math.floor(body.limit))) : 20;

  const { data, error } = await db
    .from("mp_attempts")
    .select("id, player_label, player_client_id, player_user_id, status, correct_count, strikes, elapsed_ms, ranking_time_ms, finished_at, challenge:mp_challenges!inner(prompt, sheet_id, roster_sheet_id, answer_target)")
    .in("status", ["completed", "eliminated", "expired"]);
  if (error) return err(error.message, 500);

  let rows = (data ?? []).filter((r: any) => r.finished_at);
  if (body.sheet_id) rows = rows.filter((r: any) => r.challenge?.sheet_id === body.sheet_id || r.challenge?.roster_sheet_id === body.sheet_id);
  if (!includeBots) rows = rows.filter((r: any) => !isBotClient(r.player_client_id));

  rows.sort(leaderboardCompare);
  const top = rows.slice(0, limit).map((r: any, i: number) => ({
    rank: i + 1,
    player_label: r.player_label,
    is_bot: isBotClient(r.player_client_id),
    is_you: (userId && r.player_user_id === userId) || (clientId && r.player_client_id === clientId) || false,
    completed: r.status === "completed",
    status: r.status,
    correct_count: r.correct_count,
    answer_target: r.challenge?.answer_target ?? 8,
    strikes: r.strikes,
    time_ms: r.status === "completed" ? r.elapsed_ms : r.ranking_time_ms,
    category: r.challenge?.prompt ?? null,
    finished_at: r.finished_at,
  }));

  return ok({ scope: body.sheet_id ? "category" : "global", count: rows.length, entries: top });
}

// Typeahead pool for a challenge's category. Returns the guessable universe
// (all notable players, or all arenas) — never the answer set — so the client
// can render an autocomplete without leaking which names are correct.
// broad player universe — shared by roster games and subjective lists
async function playerPool() {
  const { data, error } = await db
    .from("vw_trivia_player_career_summary")
    .select("player_name, games_played")
    .eq("season_type", "REGULAR")
    .order("games_played", { ascending: false })
    .limit(5000);
  if (error) return err(error.message, 500);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of data ?? []) { if (r.player_name && !seen.has(r.player_name)) { seen.add(r.player_name); names.push(r.player_name); } }
  return ok({ type: "player", items: names });
}

async function actionSuggest(_req: Request, body: any) {
  if (body.pool === "players") return await playerPool();   // challenge-less (lists)
  if (body.pool === "teams") return ok({ type: "team", items: TEAM_POOL });
  let sheetId: string | null = body.sheet_id ?? null;
  let kind = "top8";
  if (body.challenge_id || body.share_token) {
    const { challenge } = await loadChallenge(body);
    if (challenge) { kind = challenge.kind ?? "top8"; if (!sheetId) sheetId = challenge.sheet_id; }
  }

  // Roster: broad player universe (never the eligible pool — that would leak
  // the answers). Wide net so obscure but valid picks can still be typed.
  if (kind === "roster") {
    const { data, error } = await db
      .from("vw_trivia_player_career_summary")
      .select("player_name, games_played")
      .eq("season_type", "REGULAR")
      .order("games_played", { ascending: false })
      .limit(5000);
    if (error) return err(error.message, 500);
    const seen = new Set<string>();
    const names: string[] = [];
    for (const r of data ?? []) { if (r.player_name && !seen.has(r.player_name)) { seen.add(r.player_name); names.push(r.player_name); } }
    return ok({ type: "player", items: names });
  }

  if (!sheetId) return err("missing_sheet_ref", 400);

  const { data: sheet } = await db
    .from("perfect_sheets")
    .select("source_params")
    .eq("id", sheetId)
    .single();
  const metric = (sheet?.source_params as Record<string, unknown> | null)?.metric;

  if (metric === "arenacapacity") {
    return ok({ type: "arena", items: ARENA_POOL });
  }

  // player categories: notable players from the public career-summary view
  const { data, error } = await db
    .from("vw_trivia_player_career_summary")
    .select("player_name, career_points")
    .eq("season_type", "REGULAR")
    .order("career_points", { ascending: false })
    .limit(6000);   // broad autocomplete: every rostered player is typeable (was 1500, which hid role players)
  if (error) return err(error.message, 500);

  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of data ?? []) {
    if (r.player_name && !seen.has(r.player_name)) {
      seen.add(r.player_name);
      names.push(r.player_name);
    }
  }
  return ok({ type: "player", items: names });
}

// ---------------------------------------------------------------------------
// Subjective lists ("make your own list" — no correct answer).
// ---------------------------------------------------------------------------
function cleanItems(raw: any, max: number) {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const it of Array.isArray(raw) ? raw : []) {
    const label = String(it?.label ?? "").trim();
    if (!label) continue;
    const key = normalize(label);
    if (!key || seen.has(key)) continue;           // dedupe within a list
    seen.add(key);
    out.push({
      rank: out.length + 1, label, key,
      note: it?.note ? String(it.note).slice(0, 240) : null,
      player_key: it?.player_key ?? null,
    });
    if (out.length >= max) break;
  }
  return out;
}

async function loadTopic(body: any) {
  let q = db.from("mp_list_topics").select("*");
  if (body.topic_id) q = q.eq("id", body.topic_id);
  else if (body.share_token) q = q.eq("share_token", body.share_token);
  else return { topic: null, error: "missing_topic_ref" };
  const { data, error } = await q.single();
  if (error || !data) return { topic: null, error: "topic_not_found" };
  return { topic: data, error: null };
}

async function actionListCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return err("prompt_required", 400);
  const ranked = body.ranked !== false;
  const maxItems = Number.isFinite(body.max_items) ? Math.min(25, Math.max(1, Math.floor(body.max_items))) : 10;
  const entryType = ["player", "team", "coach", "moment"].includes(body.entry_type) ? body.entry_type : "player";
  const visibility = body.visibility === "unlisted" ? "unlisted" : "public";
  const { data: topic, error: tErr } = await db.from("mp_list_topics").insert({
    share_token: randomToken(9), prompt, ranked, max_items: maxItems, entry_type: entryType, visibility,
    creator_client_id: clientId, creator_user_id: userId, creator_label: body.label ?? "Anonymous",
  }).select("id, share_token, prompt, ranked, max_items, entry_type, visibility").single();
  if (tErr) return err(tErr.message, 500);

  let listId: string | null = null;
  if (Array.isArray(body.items) && body.items.length) {
    const { data: list } = await db.from("mp_lists").insert({
      topic_id: topic.id, author_client_id: clientId, author_user_id: userId,
      author_label: body.label ?? "Anonymous", items: cleanItems(body.items, maxItems),
    }).select("id").single();
    listId = list?.id ?? null;
  }
  return ok({ topic_id: topic.id, share_token: topic.share_token, prompt: topic.prompt, ranked: topic.ranked, max_items: topic.max_items, entry_type: topic.entry_type, visibility: topic.visibility, list_id: listId });
}

async function actionListSave(req: Request, body: any) {
  const { topic, error: tErr } = await loadTopic(body);
  if (tErr) return err(tErr, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const items = cleanItems(body.items, topic.max_items);
  const label = body.label ?? "Anonymous";

  const { data: rows } = await db.from("mp_lists").select("id, author_client_id, author_user_id").eq("topic_id", topic.id);
  const mine = (rows ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  if (mine) {
    await db.from("mp_lists").update({ items, author_label: label, updated_at: new Date().toISOString() }).eq("id", mine.id);
    return ok({ list_id: mine.id, item_count: items.length, saved: true });
  }
  const { data: created, error: cErr } = await db.from("mp_lists").insert({
    topic_id: topic.id, author_client_id: clientId, author_user_id: userId, author_label: label, items,
  }).select("id").single();
  if (cErr) return err(cErr.message, 500);
  return ok({ list_id: created.id, item_count: items.length, saved: true });
}

async function actionListOpen(req: Request, body: any) {
  const { topic, error } = await loadTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { data: lists } = await db.from("mp_lists").select("id, author_client_id, author_user_id, items, author_label").eq("topic_id", topic.id);
  const mine = (lists ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  return ok({
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, ranked: topic.ranked, max_items: topic.max_items, entry_type: topic.entry_type ?? "player", visibility: topic.visibility ?? "public", author_count: (lists ?? []).length },
    your_list: mine ? { id: mine.id, items: mine.items, author_label: mine.author_label } : null,
  });
}

async function actionListCompare(req: Request, body: any) {
  const { topic, error } = await loadTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { data: lists } = await db.from("mp_lists").select("*").eq("topic_id", topic.id).order("created_at", { ascending: true });
  const all = lists ?? [];
  const total = all.length;

  const agg = new Map<string, any>();
  for (const l of all) {
    for (const it of (l.items ?? [])) {
      const k = it.key || normalize(it.label);
      if (!k) continue;
      let e = agg.get(k);
      if (!e) { e = { label: it.label, count: 0, rankSum: 0, rankedCount: 0, authors: [] }; agg.set(k, e); }
      e.count++; e.authors.push(l.author_label);
      if (typeof it.rank === "number") { e.rankSum += it.rank; e.rankedCount++; }
    }
  }
  const consensus = Array.from(agg.values()).map((e) => ({
    label: e.label, count: e.count, pct: total ? Math.round(100 * e.count / total) : 0,
    avg_rank: e.rankedCount ? +(e.rankSum / e.rankedCount).toFixed(1) : null, authors: e.authors,
  })).sort((a, b) => b.count - a.count || ((a.avg_rank ?? 99) - (b.avg_rank ?? 99)) || a.label.localeCompare(b.label));

  const listsOut = all.map((l) => ({
    list_id: l.id, author_label: l.author_label,
    is_you: (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId) || false,
    items: (l.items ?? []).map((it: any) => ({ rank: it.rank, label: it.label, note: it.note ?? null })),
    updated_at: l.updated_at,
  }));
  return ok({ topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, ranked: topic.ranked, entry_type: topic.entry_type ?? "player" }, total_authors: total, lists: listsOut, consensus });
}

async function actionListMine(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  let q = db.from("mp_lists").select("id, items, updated_at, topic:mp_list_topics!inner(id, share_token, prompt, ranked, max_items, entry_type)").order("updated_at", { ascending: false });
  q = userId ? q.eq("author_user_id", userId) : q.eq("author_client_id", clientId);
  const { data, error } = await q;
  if (error) return err(error.message, 500);
  return ok({
    lists: (data ?? []).map((l: any) => ({
      list_id: l.id, item_count: (l.items ?? []).length, updated_at: l.updated_at,
      topic_id: l.topic?.id, share_token: l.topic?.share_token, prompt: l.topic?.prompt, ranked: l.topic?.ranked, max_items: l.topic?.max_items, entry_type: l.topic?.entry_type ?? "player",
    })),
  });
}

// Public discovery: recent public topics, ranked by how many people have listed.
async function actionListBrowse(_req: Request, _body: any) {
  const { data: topics } = await db.from("mp_list_topics")
    .select("id, share_token, prompt, ranked, entry_type, created_at")
    .eq("visibility", "public")
    .order("created_at", { ascending: false })
    .limit(60);
  const ids = (topics ?? []).map((t) => t.id);
  const { data: lists } = await db.from("mp_lists").select("topic_id")
    .in("topic_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const counts = new Map<string, number>();
  for (const l of lists ?? []) counts.set(l.topic_id, (counts.get(l.topic_id) ?? 0) + 1);
  const out = (topics ?? []).map((t) => ({
    topic_id: t.id, share_token: t.share_token, prompt: t.prompt, ranked: t.ranked,
    entry_type: t.entry_type ?? "player", author_count: counts.get(t.id) ?? 0, created_at: t.created_at,
  })).sort((a, b) => b.author_count - a.author_count || (a.created_at < b.created_at ? 1 : -1));
  return ok({ topics: out });
}

// ---------------------------------------------------------------------------
// Tier-list mode (spin a set from a pool, sort into S/A/B/C/D/F, compare).
// ---------------------------------------------------------------------------
async function loadTierTopic(body: any) {
  let q = db.from("mp_tier_topics").select("*");
  if (body.topic_id) q = q.eq("id", body.topic_id);
  else if (body.share_token) q = q.eq("share_token", body.share_token);
  else return { topic: null, error: "missing_topic_ref" };
  const { data, error } = await q.single();
  if (error || !data) return { topic: null, error: "topic_not_found" };
  return { topic: data, error: null };
}

async function actionTierCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return err("prompt_required", 400);
  const source = ["star_players", "all_teams", "champion_teams", "notable_coaches"].includes(body.pool_source) ? body.pool_source : "star_players";
  const itemType = POOL_TYPE[source];
  const drawSize = Number.isFinite(body.draw_size) ? Math.min(16, Math.max(4, Math.floor(body.draw_size))) : 8;
  const visibility = body.visibility === "unlisted" ? "unlisted" : "public";
  const era = (source === "star_players" && Number.isFinite(body.era)) ? Math.floor(body.era) : null;   // decade start year; players-only
  const pool = await tierPool(source, era);
  if (pool.length < 4) return err("pool_too_small", 500);
  const itemSet = drawSet(pool, drawSize);
  const { data: topic, error: tErr } = await db.from("mp_tier_topics").insert({
    share_token: randomToken(9), prompt, item_type: itemType, pool_source: source, draw_size: drawSize,
    item_set: itemSet, pool_params: era != null ? { era } : {}, visibility, creator_client_id: clientId, creator_user_id: userId, creator_label: body.label ?? "Anonymous",
  }).select("id, share_token, prompt, item_type, tiers, item_set").single();
  if (tErr) return err(tErr.message, 500);
  return ok({ topic_id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers: topic.tiers, item_set: topic.item_set, is_creator: true });
}

async function actionTierReroll(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const isCreator = (userId && topic.creator_user_id === userId) || (clientId && topic.creator_client_id === clientId);
  if (!isCreator) return err("only_creator_can_reroll", 403);
  const { data: others } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id").eq("topic_id", topic.id);
  const nonCreator = (others ?? []).filter((l) => !((userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId)));
  if (nonCreator.length > 0) return err("others_already_tiered", 409);
  const itemSet = drawSet(await tierPool(topic.pool_source, (topic.pool_params as any)?.era ?? null), topic.draw_size);
  await db.from("mp_tier_topics").update({ item_set: itemSet }).eq("id", topic.id);
  await db.from("mp_tier_lists").delete().eq("topic_id", topic.id);   // set changed → clear old assignments
  return ok({ topic_id: topic.id, item_set: itemSet, tiers: topic.tiers, item_type: topic.item_type });
}

async function actionTierOpen(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { data: lists } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id, assignments").eq("topic_id", topic.id);
  const mine = (lists ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  const isCreator = (userId && topic.creator_user_id === userId) || (clientId && topic.creator_client_id === clientId);
  return ok({
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers: topic.tiers, item_set: topic.item_set, author_count: (lists ?? []).length, is_creator: !!isCreator },
    your_assignments: mine?.assignments ?? {},
  });
}

async function actionTierSave(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const validKeys = new Set((topic.item_set as any[]).map((i) => i.key));
  const validTiers = new Set(topic.tiers as string[]);
  const asg: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.assignments ?? {})) { if (validKeys.has(k) && validTiers.has(v as string)) asg[k] = v as string; }
  const label = body.label ?? "Anonymous";
  const { data: rows } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id").eq("topic_id", topic.id);
  const mine = (rows ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  if (mine) {
    const patch: any = { assignments: asg, author_label: label, updated_at: new Date().toISOString() };
    if (userId && !mine.author_user_id) patch.author_user_id = userId;   // backfill so a signed-in member's board counts in crews
    await db.from("mp_tier_lists").update(patch).eq("id", mine.id);
    return ok({ list_id: mine.id, saved: true });
  }
  const { data: created, error: cErr } = await db.from("mp_tier_lists").insert({ topic_id: topic.id, author_client_id: clientId, author_user_id: userId, author_label: label, assignments: asg }).select("id").single();
  if (cErr) return err(cErr.message, 500);
  return ok({ list_id: created.id, saved: true });
}

async function actionTierCompare(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { data: lists } = await db.from("mp_tier_lists").select("*").eq("topic_id", topic.id).order("created_at", { ascending: true });
  const all = lists ?? [];
  const tiers = topic.tiers as string[];
  const tierIndex = new Map(tiers.map((t, i) => [t, i]));   // S=0 (best)
  const items = topic.item_set as any[];
  const consensus = items.map((it) => {
    const dist: Record<string, number> = {}; let sum = 0, cnt = 0;
    for (const l of all) { const t = (l.assignments || {})[it.key]; if (t && tierIndex.has(t)) { dist[t] = (dist[t] || 0) + 1; sum += tierIndex.get(t)!; cnt++; } }
    let modal: string | null = null, best = 0;
    for (const t of tiers) { const c = dist[t] || 0; if (c > best) { best = c; modal = t; } }
    const avgTier = cnt ? tiers[Math.round(sum / cnt)] : null;
    return { key: it.key, label: it.label, modal_tier: modal, avg_tier: avgTier, count: cnt, distribution: dist };
  }).sort((a, b) => (a.avg_tier == null ? 99 : tierIndex.get(a.avg_tier)!) - (b.avg_tier == null ? 99 : tierIndex.get(b.avg_tier)!) || a.label.localeCompare(b.label));
  const listsOut = all.map((l) => ({ author_label: l.author_label, is_you: (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId) || false, assignments: l.assignments }));
  return ok({ topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers, item_set: items }, total_authors: all.length, consensus, lists: listsOut });
}

async function actionTierMine(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  let q = db.from("mp_tier_lists").select("id, updated_at, author_client_id, author_user_id, topic:mp_tier_topics!inner(id, share_token, prompt, item_type)").order("updated_at", { ascending: false });
  q = userId ? q.eq("author_user_id", userId) : q.eq("author_client_id", clientId);
  const { data, error } = await q;
  if (error) return err(error.message, 500);
  return ok({ lists: (data ?? []).map((l: any) => ({ topic_id: l.topic?.id, share_token: l.topic?.share_token, prompt: l.topic?.prompt, item_type: l.topic?.item_type, updated_at: l.updated_at })) });
}

async function actionTierBrowse(_req: Request, _body: any) {
  const { data: topics } = await db.from("mp_tier_topics").select("id, share_token, prompt, item_type, created_at").eq("visibility", "public").neq("creator_client_id", "daily").order("created_at", { ascending: false }).limit(60);
  const ids = (topics ?? []).map((t) => t.id);
  const { data: lists } = await db.from("mp_tier_lists").select("topic_id").in("topic_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const counts = new Map<string, number>();
  for (const l of lists ?? []) counts.set(l.topic_id, (counts.get(l.topic_id) ?? 0) + 1);
  const out = (topics ?? []).map((t) => ({ topic_id: t.id, share_token: t.share_token, prompt: t.prompt, item_type: t.item_type, author_count: counts.get(t.id) ?? 0, created_at: t.created_at }))
    .sort((a, b) => b.author_count - a.author_count || (a.created_at < b.created_at ? 1 : -1));
  return ok({ topics: out });
}

// Resolve today's daily tier topic, creating it once if needed (share_token
// uniqueness makes creation idempotent). Shared by the solo daily and crews.
async function getOrCreateDailyTopic(): Promise<{ topic: any; date: string; dayIndex: number }> {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const token = "daily_" + date;
  const dayIndex = Math.floor(now.getTime() / 86400000);
  let { topic } = await loadTierTopic({ share_token: token });
  if (!topic) {
    // Flashback Friday: a nostalgia decade (2000s and earlier). Other days: normal rotation.
    const dow = now.getUTCDay();   // 5 = Friday (UTC)
    let prompt: string, poolSource: string, drawSizeN: number, era: number | null = null;
    if (dow === 5) {
      const decades = [1980, 1990, 2000];
      era = decades[Math.floor(dayIndex / 7) % decades.length];
      prompt = `Flashback Friday: tier these ${era}s stars`;
      poolSource = "star_players"; drawSizeN = 10;
    } else {
      const rot = DAILY_ROTATION[dayIndex % DAILY_ROTATION.length];
      prompt = rot.prompt; poolSource = rot.pool_source; drawSizeN = rot.draw_size;
    }
    const itemSet = drawSet(await tierPool(poolSource, era), drawSizeN);
    const { data: created, error: cErr } = await db.from("mp_tier_topics").insert({
      share_token: token, prompt, item_type: POOL_TYPE[poolSource], pool_source: poolSource,
      draw_size: drawSizeN, item_set: itemSet, pool_params: era != null ? { era } : {}, visibility: "public", creator_client_id: "daily", creator_label: "Daily",
    }).select("*").single();
    if (cErr) { const again = await loadTierTopic({ share_token: token }); topic = again.topic; }
    else topic = created;
  }
  return { topic, date, dayIndex };
}

// Daily debate: one shared tier topic per UTC date. Everyone gets the same set;
// reuses tier_save / tier_compare. No schema change needed.
async function actionDaily(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { topic, date } = await getOrCreateDailyTopic();
  if (!topic) return err("daily_unavailable", 500);
  const { data: lists } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id, assignments").eq("topic_id", topic.id);
  const mine = (lists ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  return ok({
    date,
    flashback: /Flashback/.test(topic.prompt),
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers: topic.tiers, item_set: topic.item_set, author_count: (lists ?? []).length, is_creator: false, is_daily: true },
    your_assignments: mine?.assignments ?? {},
    done: !!mine,
  });
}

// -----------------------------------------------------------------------------
// Crews: account-gated private group rooms that play the Daily together.
// All crew actions require a logged-in Supabase user (authedUserId). Play for
// everyone else stays fully no-account.
// -----------------------------------------------------------------------------
function makeCrewCode(): string {
  const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return Array.from(a, (b) => alpha[b % alpha.length]).join("");
}
async function uniqueCrewCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const c = makeCrewCode();
    const { data } = await db.from("mp_crews").select("id").eq("code", c).maybeSingle();
    if (!data) return c;
  }
  return makeCrewCode();
}
function dayMinus(dateStr: string, n: number): string {
  return new Date(new Date(dateStr + "T00:00:00Z").getTime() - n * 86400000).toISOString().slice(0, 10);
}
function computeStreak(dates: Set<string>, today: string): number {
  let anchor: string | null = dates.has(today) ? today : (dates.has(dayMinus(today, 1)) ? dayMinus(today, 1) : null);
  if (!anchor) return 0;
  let streak = 0, d = anchor;
  while (dates.has(d)) { streak++; d = dayMinus(d, 1); }
  return streak;
}

async function actionCrewCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const name = String(body.name ?? "").trim();
  if (name.length < 1 || name.length > 40) return err("invalid_name", 400);
  const display = (String(body.display_name ?? "").trim() || "Anonymous").slice(0, 40);
  const code = await uniqueCrewCode();
  const { data: crew, error: cErr } = await db.from("mp_crews").insert({ code, name, created_by: userId }).select("*").single();
  if (cErr) return err(cErr.message, 500);
  await db.from("mp_crew_members").insert({ crew_id: crew.id, user_id: userId, display_name: display, role: "owner" });
  return ok({ crew: { id: crew.id, code: crew.code, name: crew.name, member_cap: crew.member_cap, role: "owner", member_count: 1 } });
}

async function actionCrewJoin(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!code) return err("code_required", 400);
  const display = (String(body.display_name ?? "").trim() || "Anonymous").slice(0, 40);
  const { data: crew } = await db.from("mp_crews").select("*").eq("code", code).maybeSingle();
  if (!crew) return err("crew_not_found", 404);
  const { data: members } = await db.from("mp_crew_members").select("user_id").eq("crew_id", crew.id);
  const already = (members ?? []).some((m) => m.user_id === userId);
  if (!already) {
    if ((members ?? []).length >= crew.member_cap) return err("crew_full", 403);
    const { error: mErr } = await db.from("mp_crew_members").insert({ crew_id: crew.id, user_id: userId, display_name: display, role: "member" });
    if (mErr) return err(mErr.message, 500);
  } else if (body.display_name) {
    await db.from("mp_crew_members").update({ display_name: display }).eq("crew_id", crew.id).eq("user_id", userId);
  }
  return ok({ crew: { id: crew.id, code: crew.code, name: crew.name, member_cap: crew.member_cap, role: already ? "member" : "member", member_count: (members ?? []).length + (already ? 0 : 1) } });
}

async function actionCrewMine(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const { data: mine } = await db.from("mp_crew_members").select("crew_id, role").eq("user_id", userId);
  const ids = (mine ?? []).map((m) => m.crew_id);
  if (!ids.length) return ok({ crews: [] });
  const { data: crews } = await db.from("mp_crews").select("id, code, name").in("id", ids);
  const { data: allMembers } = await db.from("mp_crew_members").select("crew_id").in("crew_id", ids);
  const counts = new Map<string, number>();
  for (const m of allMembers ?? []) counts.set(m.crew_id, (counts.get(m.crew_id) ?? 0) + 1);
  const roleBy = new Map((mine ?? []).map((m) => [m.crew_id, m.role]));
  return ok({ crews: (crews ?? []).map((c) => ({ id: c.id, code: c.code, name: c.name, role: roleBy.get(c.id), member_count: counts.get(c.id) ?? 1 })) });
}

// The crew room for today's Daily: standings (streak + played-today), and — once
// the caller has played — everyone's boards, crew consensus, Hottest Take + badge.
async function actionCrewDaily(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const crewId = body.crew_id;
  if (!crewId) return err("crew_required", 400);
  const { data: membership } = await db.from("mp_crew_members").select("role").eq("crew_id", crewId).eq("user_id", userId).maybeSingle();
  if (!membership) return err("not_a_member", 403);
  const { data: crew } = await db.from("mp_crews").select("id, code, name").eq("id", crewId).maybeSingle();
  if (!crew) return err("crew_not_found", 404);
  const { data: members } = await db.from("mp_crew_members").select("user_id, display_name, role").eq("crew_id", crewId);
  const memberIds = (members ?? []).map((m) => m.user_id);
  const nameBy = new Map((members ?? []).map((m) => [m.user_id, m.display_name]));
  const NONE = ["00000000-0000-0000-0000-000000000000"];

  const { topic, date } = await getOrCreateDailyTopic();
  if (!topic) return err("daily_unavailable", 500);
  const tiers = topic.tiers as string[];
  const tierIndex = new Map(tiers.map((t, i) => [t, i]));
  const items = topic.item_set as any[];

  const { data: boards } = await db.from("mp_tier_lists")
    .select("id, author_user_id, assignments, created_at")
    .eq("topic_id", topic.id).in("author_user_id", memberIds.length ? memberIds : NONE);
  const played = boards ?? [];
  const boardByUser = new Map(played.map((b) => [b.author_user_id, b]));
  const iPlayed = boardByUser.has(userId);
  const reveal = iPlayed;

  // reactions on these boards (crew-scoped), aggregated per board+emoji
  const boardIds = played.map((b) => b.id);
  const { data: reactions } = await db.from("mp_reactions").select("tier_list_id, emoji, user_id").eq("crew_id", crewId).in("tier_list_id", boardIds.length ? boardIds : NONE);
  const agg = new Map<string, Map<string, { count: number; mine: boolean }>>();
  for (const r of reactions ?? []) {
    if (!agg.has(r.tier_list_id)) agg.set(r.tier_list_id, new Map());
    const m = agg.get(r.tier_list_id)!;
    const e = m.get(r.emoji) ?? { count: 0, mine: false };
    e.count++; if (r.user_id === userId) e.mine = true; m.set(r.emoji, e);
  }

  // crew consensus (modal + avg tier) among those who played
  const consensus = items.map((it) => {
    const dist: Record<string, number> = {}; let sum = 0, cnt = 0;
    for (const b of played) { const t = (b.assignments || {})[it.key]; if (t && tierIndex.has(t)) { dist[t] = (dist[t] || 0) + 1; sum += tierIndex.get(t)!; cnt++; } }
    let modal: string | null = null, best = 0;
    for (const t of tiers) { const c = dist[t] || 0; if (c > best) { best = c; modal = t; } }
    return { key: it.key, label: it.label, modal, avg_tier: cnt ? tiers[Math.round(sum / cnt)] : null, count: cnt, distribution: dist };
  });
  const modalBy = new Map(consensus.map((c) => [c.key, c.modal]));

  // Hottest Take: biggest average divergence from the crew's modal (needs >=2 players)
  let hottest: { user_id: string; score: number } | null = null;
  if (played.length >= 2) {
    for (const b of played) {
      let sum = 0, cnt = 0;
      for (const it of items) { const t = (b.assignments || {})[it.key]; const mod = modalBy.get(it.key); if (t && mod && tierIndex.has(t)) { sum += Math.abs(tierIndex.get(t)! - tierIndex.get(mod)!); cnt++; } }
      const score = cnt ? sum / cnt : 0;
      if (cnt > 0 && (!hottest || score > hottest.score)) hottest = { user_id: b.author_user_id, score };
    }
    if (hottest && hottest.score <= 0) hottest = null;
  }

  // one rotating badge (alternates day to day)
  const dIdx = Math.floor(new Date(date + "T00:00:00Z").getTime() / 86400000);
  let badge: { type: string; label: string; user_id: string } | null = null;
  if (played.length >= 1) {
    if (dIdx % 2 === 0) {
      let first = played[0];
      for (const b of played) if (b.created_at < first.created_at) first = b;
      badge = { type: "first", label: "🎯 First on the board", user_id: first.author_user_id };
    } else {
      let bestUser: string | null = null, bestUnique = 0;
      for (const b of played) {
        let uniq = 0;
        for (const it of items) { const t = (b.assignments || {})[it.key]; if (!t) continue; const shared = played.some((o) => o !== b && (o.assignments || {})[it.key] === t); if (!shared) uniq++; }
        if (uniq > bestUnique) { bestUnique = uniq; bestUser = b.author_user_id; }
      }
      if (bestUser) badge = { type: "wildcard", label: "🃏 Wildcard", user_id: bestUser };
    }
  }

  // streaks from each member's daily-play history
  const { data: dailyRows } = await db.from("mp_tier_lists").select("author_user_id, t:mp_tier_topics!inner(share_token)").in("author_user_id", memberIds.length ? memberIds : NONE);
  const streakDates = new Map<string, Set<string>>();
  for (const row of (dailyRows ?? []) as any[]) {
    const st = row.t?.share_token as string | undefined;
    if (st && st.startsWith("daily_")) {
      if (!streakDates.has(row.author_user_id)) streakDates.set(row.author_user_id, new Set());
      streakDates.get(row.author_user_id)!.add(st.slice(6));
    }
  }

  const memberOut = (members ?? []).map((m) => {
    const board = boardByUser.get(m.user_id);
    return {
      user_id: m.user_id,
      display_name: m.display_name,
      role: m.role,
      is_you: m.user_id === userId,
      played_today: !!board,
      streak: computeStreak(streakDates.get(m.user_id) ?? new Set(), date),
      board_id: board?.id ?? null,
      assignments: (reveal && board) ? board.assignments : null,
      reactions: board ? Array.from((agg.get(board.id) ?? new Map()).entries()).map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine })) : [],
    };
  }).sort((a, b) => b.streak - a.streak || a.display_name.localeCompare(b.display_name));

  return ok({
    crew: { id: crew.id, code: crew.code, name: crew.name, member_count: (members ?? []).length },
    date,
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers, item_set: items, is_daily: true },
    i_played: iPlayed,
    your_assignments: boardByUser.get(userId)?.assignments ?? {},
    players_today: played.length,
    consensus: reveal ? consensus : null,
    hottest_take: reveal && hottest ? { user_id: hottest.user_id, display_name: nameBy.get(hottest.user_id) } : null,
    badge: reveal && badge ? { type: badge.type, label: badge.label, user_id: badge.user_id, display_name: nameBy.get(badge.user_id) } : null,
    members: memberOut,
  });
}

async function actionCrewReact(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const crewId = body.crew_id, listId = body.tier_list_id, emoji = String(body.emoji ?? "").slice(0, 8);
  if (!crewId || !listId || !emoji) return err("bad_request", 400);
  const { data: mem } = await db.from("mp_crew_members").select("user_id").eq("crew_id", crewId).eq("user_id", userId).maybeSingle();
  if (!mem) return err("not_a_member", 403);
  const { data: existing } = await db.from("mp_reactions").select("id").eq("crew_id", crewId).eq("tier_list_id", listId).eq("user_id", userId).eq("emoji", emoji).maybeSingle();
  if (existing) { await db.from("mp_reactions").delete().eq("id", existing.id); return ok({ toggled: "off" }); }
  const { error: iErr } = await db.from("mp_reactions").insert({ crew_id: crewId, tier_list_id: listId, user_id: userId, emoji });
  if (iErr) return err(iErr.message, 500);
  return ok({ toggled: "on" });
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("method_not_allowed", 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err("invalid_json", 400);
  }

  try {
    switch (body.action) {
      case "sheets":
        return await actionSheets();
      case "create":
        return await actionCreate(req, body);
      case "open":
        return await actionOpen(req, body);
      case "start":
        return await actionStart(req, body);
      case "guess":
        return await actionGuess(req, body);
      case "results":
        return await actionResults(req, body);
      case "add_bot":
        return await actionAddBot(req, body);
      case "leaderboard":
        return await actionLeaderboard(req, body);
      case "suggest":
        return await actionSuggest(req, body);
      case "list_create":
        return await actionListCreate(req, body);
      case "list_save":
        return await actionListSave(req, body);
      case "list_open":
        return await actionListOpen(req, body);
      case "list_compare":
        return await actionListCompare(req, body);
      case "list_mine":
        return await actionListMine(req, body);
      case "list_browse":
        return await actionListBrowse(req, body);
      case "tier_create":
        return await actionTierCreate(req, body);
      case "tier_reroll":
        return await actionTierReroll(req, body);
      case "tier_open":
        return await actionTierOpen(req, body);
      case "tier_save":
        return await actionTierSave(req, body);
      case "tier_compare":
        return await actionTierCompare(req, body);
      case "tier_mine":
        return await actionTierMine(req, body);
      case "tier_browse":
        return await actionTierBrowse(req, body);
      case "daily":
        return await actionDaily(req, body);
      case "crew_create":
        return await actionCrewCreate(req, body);
      case "crew_join":
        return await actionCrewJoin(req, body);
      case "crew_mine":
        return await actionCrewMine(req, body);
      case "crew_daily":
        return await actionCrewDaily(req, body);
      case "crew_react":
        return await actionCrewReact(req, body);
      default:
        return err("unknown_action", 400);
    }
  } catch (e) {
    return err(`server_error: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});
