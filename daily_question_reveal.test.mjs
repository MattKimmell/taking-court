import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const court = readFileSync(new URL("./supabase/functions/mp/court.ts", import.meta.url), "utf8");
const games = readFileSync(new URL("./supabase/functions/mp/games.ts", import.meta.url), "utf8");
const crew = readFileSync(new URL("./supabase/functions/mp/crews.ts", import.meta.url), "utf8");
const router = readFileSync(new URL("./supabase/functions/mp/index.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("./supabase/migrations/20260811170530_daily_question_reveal.sql", import.meta.url), "utf8");
const feedbackMigration = readFileSync(new URL("./supabase/migrations/20260811182059_roster_guess_feedback_context.sql", import.meta.url), "utf8");

test("Daily Take uses one item lock and a required feedback continuation", () => {
  assert.match(html, /id="courtTakeFeedback"/);
  assert.match(html, /id="courtTakeContinue"/);
  assert.match(html, /api\("court_take_item_lock"/);
  assert.match(html, /COURT\.take_progress\?\.next_item_id/);
  assert.doesNotMatch(html, /setTimeout\(\(\)=>[^;]*startCourtChallenge\(\)[^;]*2200/);
  assert.match(router, /case "court_take_item_lock"/);
});

test("Daily Challenge keeps graded feedback inline and leaves duplicates in play", () => {
  assert.doesNotMatch(html, /id="challengeFeedback"/);
  assert.doesNotMatch(html, /id="challengeFeedbackContinue"/);
  assert.match(html, /function renderRosterChallengeInline\(r\)/);
  assert.match(html, /presentation:"inline"/);
  assert.match(html, /if\(r\.result==="duplicate"\)/);
  assert.match(html, /if\(ST\.isRoster && r\.feedback && \(r\.result==="correct"\|\|r\.result==="strike"\)\)/);
  assert.match(games, /mp_roster_guess_context/);
  assert.match(games, /feedback,/);
});

test("partial Take rows are excluded from every completion consumer", () => {
  assert.match(migration, /add column if not exists completed_at timestamptz/);
  assert.match(migration, /where completed_at is null/);
  assert.match(court, /\.not\("completed_at", "is", null\)/);
  assert.match(court, /const takeDone = !!mine\?\.completed_at/);
  assert.equal((crew.match(/\.not\("completed_at", "is", null\)/g) || []).length, 2);
});

test("guess context RPC is service-role-only and returns only the guessed player context", () => {
  assert.match(migration, /revoke all on function public\.mp_daily_guess_context[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.mp_daily_guess_context[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /security definer/i);
  assert.match(feedbackMigration, /revoke all on function public\.mp_roster_guess_context[\s\S]*from public, anon, authenticated/);
  assert.match(feedbackMigration, /grant execute on function public\.mp_roster_guess_context[\s\S]*to service_role/);
  assert.doesNotMatch(feedbackMigration, /security definer/i);
});
