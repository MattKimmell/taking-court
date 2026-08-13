import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const games  = readFileSync(new URL("./supabase/functions/mp/games.ts", import.meta.url), "utf8");
const shared = readFileSync(new URL("./supabase/functions/mp/shared.ts", import.meta.url), "utf8");
const up     = readFileSync(new URL("./supabase/migrations/20260813120000_ranked_leader_sheets.sql", import.meta.url), "utf8");
const scope  = readFileSync(new URL("./supabase/migrations/20260813123000_scope_leader_metrics.sql", import.meta.url), "utf8");
const down   = readFileSync(new URL("./supabase/migrations/20260813120000_ranked_leader_sheets.down.sql", import.meta.url), "utf8");

// The prompt is the thing a player reads and the thing that can lie, so it is
// lifted out and run for real rather than pattern-matched.
function lift(src, re, label) {
  const m = src.match(re);
  assert.ok(m, `${label} not found`);
  return m[0];
}
const stripTypes = (s) => s
  .replace(/:\s*Record<[^>]*>/g, "")
  .replace(/:\s*(string|number|boolean)\[\]/g, "")
  .replace(/\)\s*:\s*(string|number|boolean)\s*\{/g, ") {")
  .replace(/([(,]\s*\w+)\s*:\s*(string|number|boolean)\b/g, "$1")
  // Named types (PoolEntry, PoolEntry[]) only where an annotation can legally
  // sit. The lookahead is what keeps a ternary's `: Math.round(...)` intact.
  .replace(/\??:\s*[A-Z]\w*(\[\])?(?=\s*[),={])/g, "");

const promptEnv = [
  lift(games, /const TEAM_NAMES[\s\S]*?\n\};/, "TEAM_NAMES"),
  lift(games, /const POS_PLURAL.*?\};/, "POS_PLURAL"),
  lift(games, /const AWARD_PHRASE[\s\S]*?\n\};/, "AWARD_PHRASE"),
  lift(games, /const DRAFT_PHRASE[\s\S]*?\n\};/, "DRAFT_PHRASE"),
  lift(games, /const SEASON_AWARDS[\s\S]*?\n\]\);/, "SEASON_AWARDS"),
  lift(games, /const METRIC_NOUN[\s\S]*?\n\};/, "METRIC_NOUN"),
  lift(games, /function filterPhrase[\s\S]*?\n\}/, "filterPhrase"),
  lift(games, /function rankedPhrase[\s\S]*?\n\}/, "rankedPhrase"),
  "return { rankedPhrase, filterPhrase };",
].join("\n");
const { rankedPhrase } = new Function(stripTypes(promptEnv))();

test("a scoped leader board says the scope, and never says career", () => {
  // The totals behind a ranked board are per (player, team, decade). Saying
  // "career" over a Bulls board would be a different and false question.
  assert.equal(
    rankedPhrase({ metric: "points", team: "CHI" }, 8),
    "Name the 8 players with the most points for the Bulls.");
  assert.equal(
    rankedPhrase({ metric: "assists", decade: 1990 }, 8),
    "Name the 8 players with the most assists in the 1990s.");
  assert.equal(
    rankedPhrase({ metric: "blocks", team: "CHI", decade: 1990 }, 5),
    "Name the 5 players with the most blocks for the Bulls in the 1990s.");
  for (const f of [{ metric: "points", team: "CHI" }, { metric: "points", decade: 2010 }]) {
    assert.doesNotMatch(rankedPhrase(f, 8), /career/, "a scoped board must not claim career totals");
  }
});

test("only an unscoped leader board claims career totals", () => {
  assert.equal(
    rankedPhrase({ metric: "points" }, 8),
    "Name the 8 players with the most career points.");
  assert.equal(
    rankedPhrase({ metric: "games" }, 12),
    "Name the 12 players with the most career games played.");
});

test("position narrows the subject; team and decade never appear twice", () => {
  assert.equal(
    rankedPhrase({ metric: "points", team: "CHI", position: "G" }, 8),
    "Name the 8 guards with the most points for the Bulls.");
  // "played for the Bulls ... for the Bulls" would be the bug.
  const once = rankedPhrase({ metric: "points", team: "CHI", position: "G" }, 8);
  assert.equal(once.match(/Bulls/g).length, 1);
});

test("a season award keeps its own team, because scoring there does not imply winning there", () => {
  // Shaq won ROY with Orlando and reached the Lakers four years later, so
  // "won MVP with the Lakers" is a real constraint that "points for the
  // Lakers" does not imply. It has to survive into the sentence.
  const s = rankedPhrase({ metric: "points", team: "LAL", award: "mvp" }, 4);
  assert.match(s, /won MVP with the Lakers/);
  assert.match(s, /the most points for the Lakers\.$/);
  // A subject carrying a relative clause takes the comma, or the two "with"s
  // run together and the sentence stops parsing on first read.
  assert.match(s, /, with the most/);
});

test("an unranked prompt is untouched", () => {
  const { filterPhrase } = new Function(stripTypes(promptEnv))();
  assert.equal(filterPhrase({ team: "CHI", position: "G" }), "guards who played for the Bulls");
  assert.match(games, /export function composeFilterPrompt[\s\S]*?if \(f\.metric\) return rankedPhrase\(f, target\);[\s\S]*?return `Name \$\{target\} \$\{filterPhrase\(f\)\}\.`;/);
});

// ---------------------------------------------------------------- the reveal
const revealEnv = [
  lift(shared, /export const RARITY_LABEL.*?\};/, "RARITY_LABEL").replace("export ", ""),
  lift(shared, /export const isRankedPool[\s\S]*?;\n/, "isRankedPool").replace("export ", ""),
  lift(shared, /export function rosterRevealTop[\s\S]*?\n\}/, "rosterRevealTop").replace("export ", ""),
  lift(shared, /export function rosterRevealRanked[\s\S]*?\n\}/, "rosterRevealRanked").replace("export ", ""),
  lift(shared, /export function rosterRevealFor[\s\S]*?\n\}/, "rosterRevealFor").replace("export ", ""),
  "return { rosterRevealFor, isRankedPool };",
].join("\n");
const { rosterRevealFor, isRankedPool } = new Function(stripTypes(revealEnv))();

const rankedPool = [
  { player_key: "b", display_name: "Scottie Pippen", accepted: [], rarity_tier: "common", rarity_score: 70, rank: 2, metric_value: 15123 },
  { player_key: "a", display_name: "Michael Jordan", accepted: [], rarity_tier: "common", rarity_score: 99, rank: 1, metric_value: 29277 },
  { player_key: "c", display_name: "Bob Love",       accepted: [], rarity_tier: "rare",   rarity_score: 30, rank: 3, metric_value: 12623 },
];
const openPool = rankedPool.map(({ rank, metric_value, ...p }) => p);

test("a ranked board reveals in full, in rank order, with its numbers", () => {
  // The rarity-mixed three exist because an open pool holds more than you
  // reached. A leaders board IS the ask, so hiding some would hide the answer.
  const r = rosterRevealFor(rankedPool);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => x.slot), [1, 2, 3]);
  assert.deepEqual(r.map((x) => x.display_name), ["Michael Jordan", "Scottie Pippen", "Bob Love"]);
  assert.equal(r[0].context_label, "29,277");
});

test("an open pool still reveals three, ordered by fame, with rarity labels", () => {
  assert.equal(isRankedPool(openPool), false);
  const r = rosterRevealFor(openPool);
  assert.equal(r.length, 3);
  assert.equal(r[0].display_name, "Michael Jordan");
  assert.equal(r[0].context_label, "Common");
});

test("a half-ranked pool is treated as open, never as ranked", () => {
  const mixed = [rankedPool[0], { ...rankedPool[1], rank: null, metric_value: null }];
  assert.equal(isRankedPool(mixed), false);
  assert.equal(isRankedPool([]), false);
});

// ------------------------------------------------------------- the invariants
test("the metric whitelist is the same list in TypeScript and in SQL", () => {
  const ts = [...games.match(/const PREVIEW_METRICS = new Set\(\[(.*?)\]\)/)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const sql = [...up.match(/mp_is_metric[\s\S]*?in \((.*?)\)/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(ts.slice().sort(), sql.slice().sort());
  assert.ok(!ts.includes("ppg"), "ppg needs a min-games rule and is deliberately out");
});

test("a metric ranks and never filters, so no shipped pool can shift", () => {
  // The whole migration rests on this: mp_facet_match is not redefined, so the
  // 0039 rule (re-cut every sheet when the predicate changes) does not fire.
  assert.doesNotMatch(up,    /create or replace function public\.mp_facet_match/i);
  assert.doesNotMatch(scope, /create or replace function public\.mp_facet_match/i);
  // The new pool columns are nullable, which is what makes every pre-existing
  // row already correct and the backfill unnecessary.
  assert.match(up, /add column if not exists "rank"\s+smallint,\s*\n\s*add column if not exists metric_value numeric;/);
});

test("metric joins the identity key, so ranked and unranked cannot collide", () => {
  assert.match(up, /unnest\(array\['team','position','decade','award','draft',\s*\n?\s*'college','conference','metric'\]\)/);
  // And an absent metric leaves the key byte-identical, because the key is
  // built by whitelist-and-skip rather than by listing every slot.
  assert.match(up, /where f \? k and f->>k is not null/);
});

test("the down migration reverses every piece the two up migrations add", () => {
  for (const dropped of [
    /drop function if exists public\.mp_facet_ranked_pool/,
    /drop function if exists public\.mp_facet_metric_count/,
    /drop function if exists public\.mp_is_metric/,
    /drop function if exists public\.mp_rebuild_stat_totals/,
    /drop table\s+if exists public\.mp_player_stat_totals/,
    /drop column if exists "rank"/,
    /drop column if exists career_assists/,
  ]) assert.match(down, dropped, `down migration is missing ${dropped}`);
});

test("a scoped board gets no all-time strike context, because the number would mislead", () => {
  // mp_player_metric_rank reports an ALL-TIME league rank. On "most points for
  // the Bulls", telling someone LeBron is 1st all-time explains nothing about
  // why he is not an answer.
  assert.match(shared, /if \(sp\.team != null \|\| sp\.decade != null\) return null;/);
  assert.match(shared, /RANKED_METRIC_ALIAS[\s\S]*?points: "career_points"/);
});

test("the scoped totals table is deny-all like every other mp_ table", () => {
  assert.match(scope, /alter table public\.mp_player_stat_totals enable row level security;/);
  // Combined multi-team lines would double-count a traded season.
  assert.match(scope, /team not in \('NTM','2TM','3TM','4TM','5TM'\)/);
  // A season is filed under the year it ENDS, matching mp_player_award_seasons.
  assert.match(scope, /\(t\.season::int \/ 10\) \* 10/);
});
