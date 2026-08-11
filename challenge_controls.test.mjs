import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const games = readFileSync(new URL("./supabase/functions/mp/games.ts", import.meta.url), "utf8");
const court = readFileSync(new URL("./supabase/functions/mp/court.ts", import.meta.url), "utf8");
const router = readFileSync(new URL("./supabase/functions/mp/index.ts", import.meta.url), "utf8");
const feedbackMigration = readFileSync(new URL("./supabase/migrations/20260811203000_fix_roster_feedback_permissions.sql", import.meta.url), "utf8");

test("active Challenge exposes Back, restart, and Enter controls", () => {
  assert.match(html, /id="playBack">← Back</);
  assert.match(html, /id="playRestart"[^>]*aria-label="Restart Challenge"[^>]*>↻</);
  assert.match(html, /id="guessBtn"[^>]*>Enter</);
  assert.doesNotMatch(html, /id="playExitCourt"/);
});

test("Back exits every Challenge surface through its recorded origin", () => {
  assert.match(html, /function leaveChallenge\(\)[\s\S]*if\(ST\.isCourtDaily\)\{ goHome\(\); return; \}[\s\S]*show\(CHALLENGE_RETURN_SCREEN\)/);
  assert.match(html, /\$\("playBack"\)\.onclick=leaveChallenge/);
});

test("restart is confirmed and resets the server-authoritative attempt", () => {
  assert.match(html, /window\.confirm\("Restart this Challenge\? Your current progress and timer will be cleared\."\)/);
  assert.match(html, /api\("restart",\{ attempt_id:ST\.attempt_id, attempt_token:ST\.attempt_token \}\)/);
  assert.match(router, /case "restart":[\s\S]*actionRestart/);
  assert.match(games, /export async function actionRestart/);
  for (const field of ["correct_count: 0", "strikes: 0", "filled_slots: \{\}", "guesses: \[\]", "finished_at: null", "elapsed_ms: null"]) {
    assert.match(games, new RegExp(field.replace(/[{}[\]]/g, "\\$&")));
  }
  assert.match(games, /attempt\.attempt_token !== attemptToken/);
  assert.match(games, /attempt\.status !== "in_progress"/);
});

test("feedback coverage includes every Challenge route and format", () => {
  // Daily delegates grading to the same actionGuess used by freeplay/shared play.
  assert.match(court, /const res = await actionGuess\(req, body\)/);
  // Roster modes return player-fact feedback; Top 8 retains rank/value near-miss feedback.
  assert.match(games, /if \(isRoster && \(result === "correct" \|\| result === "strike"\)/);
  assert.match(games, /const guessInfo = \(!isRoster && result === "strike"\) \? await strikeContext/);
  assert.match(games, /context_label: result === "correct" \? matchedContext/);
  assert.match(html, /if\(ST\.isRoster && r\.feedback/);
  assert.match(html, /#\$\{r\.slot\} \$\{esc\(r\.display_name\)\}/);
  assert.match(html, /r\.guess_info/);
});

test("roster feedback context can read private source data only through service role", () => {
  assert.match(feedbackMigration, /alter function public\.mp_roster_guess_context\(text, text, jsonb\)[\s\S]*security definer/);
  assert.match(feedbackMigration, /revoke all[\s\S]*from public, anon, authenticated/);
  assert.match(feedbackMigration, /grant execute[\s\S]*to service_role/);
});
