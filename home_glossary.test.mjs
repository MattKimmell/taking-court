import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("./service-worker.js", import.meta.url), "utf8");

// Exercise the real Home copy map rather than asserting on strings twice: the
// function is lifted out of the single-file client and called per beat state.
const source = html.match(/function courtHomeCopy\([\s\S]*?\n\}/);
assert.ok(source, "courtHomeCopy not found in index.html");
const courtHomeCopy = new Function(`return (${source[0]})`)();

const FIXTURES = {
  fresh: {},
  take_in_progress: { beats: { take: false, challenge: false }, takeAnswered: 2 },
  challenge_open: { beats: { take: true, challenge: false, full_stack: false } },
  challenge_in_progress: { beats: { take: true }, attemptStatus: "in_progress" },
  full_stack: { beats: { take: true, challenge: true, full_stack: true }, attemptStatus: "completed" },
};

test("every Daily beat state gets its glossary CTA and note", () => {
  assert.deepEqual(courtHomeCopy(FIXTURES.fresh), {
    state: "fresh", cta: "Play Now", note: "Think You Know Ball?",
  });
  assert.deepEqual(courtHomeCopy(FIXTURES.take_in_progress), {
    state: "take_in_progress", cta: "Continue", note: "Take 2 of 3 locked. Finish when you're back.",
  });
  assert.deepEqual(courtHomeCopy(FIXTURES.challenge_open), {
    state: "challenge_open", cta: "Continue", note: "Your Take is recorded. Your Challenge Awaits.",
  });
  assert.deepEqual(courtHomeCopy(FIXTURES.challenge_in_progress), {
    state: "challenge_in_progress", cta: "Resume Challenge", note: "Your board is waiting.",
  });
  assert.deepEqual(courtHomeCopy(FIXTURES.full_stack), {
    state: "full_stack", cta: "Review Your Daily", note: "See your recap and share card.",
  });
});

test("a live attempt is promised before the stack, matching courtContinueRoute", () => {
  // courtContinueRoute resumes an in-progress attempt ahead of an unfinished Take,
  // so the button cannot say Continue-into-the-Take while the board is open.
  assert.equal(courtHomeCopy({ beats: {}, takeAnswered: 1, attemptStatus: "in_progress" }).cta, "Resume Challenge");
  // A finished attempt is not a live board.
  for (const status of ["completed", "eliminated", "expired", null]) {
    assert.equal(courtHomeCopy({ beats: { take: true }, attemptStatus: status }).state, "challenge_open");
  }
});

test("Challenge done before the Take still points at the open beat", () => {
  const copy = courtHomeCopy({ beats: { take: false, challenge: true } });
  assert.equal(copy.cta, "Continue");
  assert.match(copy.note, /Take is still open/);
});

test("the locked count is progress-aware and clamped to the three items", () => {
  assert.match(courtHomeCopy({ takeAnswered: 1 }).note, /Take 1 of 3 locked/);
  assert.match(courtHomeCopy({ takeAnswered: 3 }).note, /Take 3 of 3 locked/);
  assert.match(courtHomeCopy({ takeAnswered: 9 }).note, /Take 3 of 3 locked/);
  assert.equal(courtHomeCopy({ takeAnswered: -1 }).state, "fresh");
  assert.equal(courtHomeCopy({ takeAnswered: "x" }).state, "fresh");
});

test("Home paints the map and keeps no Continue Court language", () => {
  assert.doesNotMatch(html, /Continue Court/);
  assert.doesNotMatch(html, /id=["']lobbyDoneLine["']/);
  assert.match(html, /id="lobbyCourtTitle"/);
  assert.match(html, /id="lobbyCourtNote"/);
  assert.match(html, /const copy=courtHomeCopy\(\{[\s\S]*?attemptStatus:r\.challenge_attempt&&r\.challenge_attempt\.status/);
  assert.match(html, /title\.textContent=copy\.cta/);
  assert.match(html, /note\.textContent=copy\.note/);
  assert.match(html, /btn\.innerHTML = copy\.cta/);
});

test("copy release bumps the PWA cache", () => {
  assert.match(worker, /const CACHE = "tc-v41"/);
});
