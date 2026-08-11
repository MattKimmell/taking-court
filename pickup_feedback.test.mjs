import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const party = readFileSync(new URL("./supabase/functions/mp/party.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("./supabase/migrations/20260811191116_pickup_challenge_feedback.sql", import.meta.url), "utf8");

test("Pickup freezes source filters onto each live session", () => {
  assert.match(migration, /alter table public\.mp_party_sessions[\s\S]*add column if not exists source_filters jsonb/);
  assert.match(party, /source_filters: sourceFilters/);
  assert.match(party, /sourceFilters = \(prompt\.source_filters/);
});

test("Rapid Fire returns factual feedback for both correct answers and misses", () => {
  assert.match(party, /async function partyGuessFeedback/);
  assert.match(party, /partyGuessFeedback\("strike"/);
  assert.match(party, /partyGuessFeedback\([\s\S]*"correct"/);
  assert.match(party, /result: "miss"[\s\S]*feedback/);
  assert.match(party, /result: "correct"[\s\S]*feedback/);
});

test("Pickup renders feedback inline on the shared Challenge board", () => {
  assert.match(html, /r\.feedback\?\.explanation \? `\$\{e\}\$\{esc\(r\.feedback\.explanation\)\}`/);
  assert.match(html, /r\.feedback\?\.explanation \? `✕ \$\{esc\(r\.feedback\.explanation\)\}`/);
});

test("all legacy public Pickup prompts receive a feedback facet", () => {
  for (const slug of ["pick-1", "points-20k", "hall-of-fame", "top-3-picks", "allstar-10", "rings-3"]) {
    assert.match(migration, new RegExp(`when '${slug}'`));
  }
});
