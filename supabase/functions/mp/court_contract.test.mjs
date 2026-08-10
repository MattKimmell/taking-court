import assert from "node:assert/strict";
import test from "node:test";
import {
  dailyChallengeForDate,
  houseTakeForDate,
  normalizeTakeAnswers,
  takeCourtBeats,
  takeConsensus,
  validateDailyChallenge,
  validateTakeItems,
} from "./court_contract.js";

test("house take has exactly three valid rank/MC items", () => {
  const take = houseTakeForDate("2026-08-10");
  assert.equal(validateTakeItems(take.items), null);
  assert.equal(take.items.length, 3);
  assert.ok(take.items.every((item) => item.type === "rank" || item.type === "multiple_choice"));
});

test("lock payload must complete all three items", () => {
  const take = houseTakeForDate("2026-08-10");
  const partial = { [take.items[0].id]: take.items[0].options.map((option) => option.key) };
  assert.equal(normalizeTakeAnswers(take.items, partial).error, "invalid_answer");
});

test("rank answers must contain every option exactly once", () => {
  const take = houseTakeForDate("2026-08-10");
  const answers = {};
  for (const item of take.items) {
    answers[item.id] = item.type === "rank"
      ? [item.options[0].key, item.options[0].key]
      : item.options[0].key;
  }
  assert.equal(normalizeTakeAnswers(take.items, answers).error, "invalid_rank_answer");
});

test("consensus reports honest totals for multiple-choice and rank items", () => {
  const take = houseTakeForDate("2026-08-10");
  const answers = {};
  for (const item of take.items) {
    answers[item.id] = item.type === "rank"
      ? item.options.map((option) => option.key)
      : item.options[0].key;
  }
  const consensus = takeConsensus(take.items, [{ answers }]);
  assert.equal(consensus.length, 3);
  assert.ok(consensus.every((row) => row.total === 1));
  assert.ok(consensus.some((row) => row.type === "rank" && row.ranking[0].avg_rank === 1));
  assert.ok(consensus.some((row) => row.type === "multiple_choice" && row.choices[0].count === 1));
});

test("daily challenge is a safe team or college roster definition", () => {
  const challenge = dailyChallengeForDate("2026-08-10");
  assert.equal(validateDailyChallenge(challenge), null);
  assert.ok(["team", "college"].includes(challenge.axis));
  assert.ok(["G", "F", "C"].includes(challenge.position));
  assert.ok(challenge.target >= 3 && challenge.target <= 8);
});

test("court beats distinguish take-only, challenge-only, and full-stack", () => {
  assert.deepEqual(takeCourtBeats({ takeDone: true, challengeDone: false }), {
    take: true,
    challenge: false,
    full_stack: false,
  });
  assert.deepEqual(takeCourtBeats({ takeDone: false, challengeDone: true }), {
    take: false,
    challenge: true,
    full_stack: false,
  });
  assert.deepEqual(takeCourtBeats({ takeDone: true, challengeDone: true }), {
    take: true,
    challenge: true,
    full_stack: true,
  });
});
