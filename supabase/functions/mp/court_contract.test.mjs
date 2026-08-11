import assert from "node:assert/strict";
import test from "node:test";
import {
  dailyChallengeForDate,
  courtShareSummary,
  crewCanRevealTakes,
  crewMemberCourtFlags,
  houseTakeForDate,
  normalizeTakeAnswers,
  playerTakeLockOut,
  takeCourtBeats,
  takeConsensus,
  takeHotScore,
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

test("court share summaries prefer the right completion state", () => {
  const take = houseTakeForDate("2026-08-10");
  const challenge = dailyChallengeForDate("2026-08-10");
  const base = {
    date: "2026-08-10",
    take,
    challenge,
    streak: { current: 4 },
    consensusGate: { have: 2 },
    challengeAttempt: { status: "completed", correct_count: 5, strikes: 1 },
  };

  assert.equal(courtShareSummary({ ...base, beats: { take: true, challenge: false } }).kind, "take_only");
  assert.equal(courtShareSummary({ ...base, beats: { take: false, challenge: true } }).kind, "challenge_only");
  const full = courtShareSummary({ ...base, beats: { take: true, challenge: true } });
  assert.equal(full.kind, "full_stack");
  assert.match(full.text, /Daily Court full stack/);
  assert.equal(full.challenge_score.correct_count, 5);
});

test("player-authored take uses the same three-item lock and compare contract", () => {
  const take = {
    title: "Group chat agenda",
    items: [
      {
        id: "first-pick",
        type: "multiple_choice",
        prompt: "Who starts the argument?",
        options: [{ key: "a", label: "Player A" }, { key: "b", label: "Player B" }],
      },
      {
        id: "trust",
        type: "rank",
        prompt: "Rank who you trust late.",
        options: [{ key: "c", label: "Player C" }, { key: "d", label: "Player D" }],
      },
      {
        id: "closer",
        type: "multiple_choice",
        prompt: "Who closes?",
        options: [{ key: "e", label: "Player E" }, { key: "f", label: "Player F" }],
      },
    ],
  };
  const answers = { "first-pick": "a", trust: ["d", "c"], closer: "e" };
  assert.equal(validateTakeItems(take.items), null);
  assert.deepEqual(normalizeTakeAnswers(take.items, answers).answers, answers);
  assert.equal(takeConsensus(take.items, [{ answers }])[0].choices[0].count, 1);
});

test("player take lock response keeps full topic and locked true over compare payload", () => {
  const topicOut = {
    id: "t1",
    share_token: "abc",
    title: "Title",
    items: [{ id: "i1" }],
    visibility: "unlisted",
    review_status: "unsubmitted",
    is_creator: true,
    author_count: 1,
  };
  const compareOut = {
    topic: { id: "t1", share_token: "abc", title: "Title", author_count: 1 },
    locked: false,
    your_answers: { i1: "a" },
    consensus: [],
    consensus_gate: { have: 1, honest_empty: true },
  };
  const out = playerTakeLockOut(compareOut, topicOut);
  assert.equal(out.locked, true);
  assert.deepEqual(out.topic, topicOut);
  assert.equal(out.your_answers.i1, "a");
  assert.equal(out.consensus_gate.have, 1);
  assert.ok(!("visibility" in compareOut.topic));
  assert.equal(out.topic.visibility, "unlisted");
});

test("crew reveal gates Takes until the viewer locked", () => {
  assert.equal(crewCanRevealTakes(false), false);
  assert.equal(crewCanRevealTakes(true), true);
  assert.deepEqual(crewMemberCourtFlags({ takeDone: true, challengeDone: false }), {
    take_done: true,
    challenge_done: false,
    played_today: true,
  });
  assert.deepEqual(crewMemberCourtFlags({ takeDone: false, challengeDone: true }), {
    take_done: false,
    challenge_done: true,
    played_today: true,
  });
  assert.deepEqual(crewMemberCourtFlags({ takeDone: false, challengeDone: false }), {
    take_done: false,
    challenge_done: false,
    played_today: false,
  });
});

test("hottest take scores divergence from crew consensus", () => {
  const items = [
    {
      id: "mc",
      type: "multiple_choice",
      prompt: "Who?",
      options: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    },
    {
      id: "rk",
      type: "rank",
      prompt: "Rank",
      options: [{ key: "x", label: "X" }, { key: "y", label: "Y" }],
    },
  ];
  const consensus = takeConsensus(items, [
    { answers: { mc: "a", rk: ["x", "y"] } },
    { answers: { mc: "a", rk: ["x", "y"] } },
  ]);
  const modal = takeHotScore(items, { mc: "a", rk: ["x", "y"] }, consensus);
  const hot = takeHotScore(items, { mc: "b", rk: ["y", "x"] }, consensus);
  assert.ok(hot > modal);
  assert.equal(modal, 0);
});
