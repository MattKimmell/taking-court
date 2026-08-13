import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  challengeShareAsk,
  courtShareSummary,
  COURT_SHARE_CTA,
  dailyChallengeForDate,
  houseTakeForDate,
  takeShareQuestion,
} from "./supabase/functions/mp/court_contract.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

// The outbound text is assembled across two files — the server builds the card and
// the client appends the link — so exercise the real client half against a real
// summary rather than trusting the seam.
function lift(name) {
  const source = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(source, `${name} not found in index.html`);
  return source[0];
}
const courtShareText = new Function(
  "location",
  `${lift("courtShareLink")}\n${lift("courtShareText")}\nreturn courtShareText;`,
)({ origin: "https://mattkimmell.github.io", pathname: "/taking-court/" });

const take = houseTakeForDate("2026-08-12");
const challenge = dailyChallengeForDate("2026-08-12");
const summary = courtShareSummary({
  date: "2026-08-12",
  take,
  challenge,
  beats: { take: true, challenge: true },
  streak: { current: 3 },
  consensusGate: { have: 4 },
  challengeAttempt: { status: "completed", correct_count: challenge.target, strikes: 1 },
});

test("what the player sends is the invite, the questions, the signature, the link", () => {
  assert.equal(courtShareText(summary), [
    COURT_SHARE_CTA,
    "",
    takeShareQuestion(take),
    `${challengeShareAsk(challenge)} ✓`,
    "",
    "Taking Court · Aug 12 · 🔥 3",
    "",
    "https://mattkimmell.github.io/taking-court/?court=1&day=2026-08-12",
  ].join("\n"));
});

test("the invite leads and the link closes, each on its own line", () => {
  const lines = courtShareText(summary).split("\n");
  // A card that opened on branding made the reader get past it to reach
  // anything they could answer.
  assert.equal(lines[0], COURT_SHARE_CTA);
  assert.match(lines[lines.length - 1], /^https:\/\//);
  assert.equal(lines[lines.length - 2], "", "the link stands alone");
  // Brand, date and streak share one line rather than stacking three.
  assert.equal(lines[lines.length - 3], "Taking Court · Aug 12 · 🔥 3");
});

test("the in-app preview renders the outbound text, not a shorter summary", () => {
  assert.match(html, /\$\(prefix\+"Text"\)\.textContent=courtShareText\(summary\)/);
  // Both share surfaces go through the one renderer.
  assert.match(html, /renderCourtShare\("courtShare", COURT\.share\)/);
  assert.match(html, /renderCourtShare\("resultsCourtShare", ST\.isCourtDaily \? COURT\.share : null\)/);
  // navigator.share and the clipboard fallback are handed the same string.
  assert.match(html, /const text=courtShareText\(summary\);[\s\S]*navigator\.share\(\{ title: summary\.title\|\|"Daily Court", text \}\)[\s\S]*writeText\(text\)/);
});

test("share stays on the recap surfaces and off Home", () => {
  const lobby = html.slice(html.indexOf('<div id="lobby"'), html.indexOf('<!-- ===================== GAME MODES'));
  assert.doesNotMatch(lobby, /share/i);
  assert.match(html, /id="courtShareCard"/);
  assert.match(html, /id="resultsCourtShareCard"/);
});

test("no receipt dialect survives: no emoji grid, no score line, no locked answers", () => {
  const text = courtShareText(summary);
  assert.doesNotMatch(text, /🟩|🟨|⬛|🟥/);
  assert.doesNotMatch(text, /\d+\s*\/\s*\d+(?!\d)/);
  assert.ok(!text.includes("Take locked:"));
  assert.ok(!text.includes("Play today's Court"));
  for (const item of take.items) {
    for (const option of item.options) assert.ok(!text.includes(option.label));
  }
});
