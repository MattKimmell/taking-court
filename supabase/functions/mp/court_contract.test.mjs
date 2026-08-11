import assert from "node:assert/strict";
import test from "node:test";
import {
  courtContinueRoute,
  dailyChallengeForDate,
  courtShareSummary,
  crewCanRevealTakes,
  crewMemberCourtFlags,
  dayCountsForStreak,
  frozenChallengePublicFields,
  houseTakeForDate,
  normalizeTakeAnswers,
  playerTakeCreateDefaults,
  playerTakeLockOut,
  takeCourtBeats,
  takeConsensus,
  takeHotScore,
  takeIsPubliclyListed,
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

test("challenge beat: frozen definition is identical for a date and coverage-safe", () => {
  const a = dailyChallengeForDate("2026-08-10");
  const b = dailyChallengeForDate("2026-08-10");
  assert.equal(validateDailyChallenge(a), null);
  assert.deepEqual(frozenChallengePublicFields(a), frozenChallengePublicFields(b));
  assert.equal(a.axis === "team" || a.axis === "college", true);
  assert.ok(["G", "F", "C"].includes(a.position));
  assert.ok(a.target >= 3 && a.target <= 8);
  assert.ok(a.prompt);
  assert.equal(validateDailyChallenge({ ...a, axis: "height" }), "invalid_challenge_axis");
  assert.equal(validateDailyChallenge({ ...a, target: 2 }), "invalid_challenge_target");
  assert.equal(validateDailyChallenge({ ...a, target: 9 }), "invalid_challenge_target");
  assert.equal(validateDailyChallenge({ ...a, position: "PG" }), "invalid_challenge_position");
});

test("challenge beat: take-then-exit, challenge-only, and double-complete stay one streak day", () => {
  const takeOnly = takeCourtBeats({ takeDone: true, challengeDone: false });
  const challengeOnly = takeCourtBeats({ takeDone: false, challengeDone: true });
  const full = takeCourtBeats({ takeDone: true, challengeDone: true });
  const none = takeCourtBeats({ takeDone: false, challengeDone: false });

  assert.equal(dayCountsForStreak(takeOnly), true);
  assert.equal(dayCountsForStreak(challengeOnly), true);
  assert.equal(dayCountsForStreak(full), true);
  assert.equal(dayCountsForStreak(none), false);
  // double-submit / full-stack does not create a second day contribution
  assert.equal(dayCountsForStreak(takeOnly), dayCountsForStreak(full));
  assert.equal(full.full_stack, true);
  assert.equal(takeOnly.full_stack, false);
});

test("challenge beat: continue route resumes in-progress Challenge and keeps Take-first otherwise", () => {
  assert.equal(
    courtContinueRoute({ takeDone: true, challengeDone: false, attemptStatus: "in_progress" }),
    "resume_challenge",
  );
  assert.equal(
    courtContinueRoute({ takeDone: true, challengeDone: false, attemptStatus: null }),
    "challenge_ready",
  );
  assert.equal(
    courtContinueRoute({ takeDone: false, challengeDone: false, attemptStatus: null }),
    "take",
  );
  assert.equal(
    courtContinueRoute({ takeDone: false, challengeDone: true, attemptStatus: "completed" }),
    "take",
  );
  assert.equal(
    courtContinueRoute({ takeDone: true, challengeDone: true, attemptStatus: "completed" }),
    "consensus",
  );
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
  assert.equal(full.path, "?court=1&day=2026-08-10");
  assert.equal(courtShareSummary({ ...base, beats: { take: false, challenge: false } }), null);
});

test("share card facts come from server beats and challenge attempt, not client invent", () => {
  const take = houseTakeForDate("2026-08-10");
  const challenge = dailyChallengeForDate("2026-08-10");
  const takeOnly = courtShareSummary({
    date: "2026-08-10",
    take,
    challenge,
    beats: { take: true, challenge: false },
    streak: { current: 2 },
    consensusGate: { have: 1 },
    challengeAttempt: { status: "completed", correct_count: 99, strikes: 0 },
  });
  assert.equal(takeOnly.kind, "take_only");
  assert.equal(takeOnly.challenge_score, null);
  assert.match(takeOnly.text, /Take locked/);
  assert.ok(!/Challenge:/.test(takeOnly.text));

  const challengeOnly = courtShareSummary({
    date: "2026-08-10",
    take,
    challenge,
    beats: { take: false, challenge: true },
    streak: { current: 1 },
    consensusGate: { have: 0 },
    challengeAttempt: { status: "completed", correct_count: 4, strikes: 2 },
  });
  assert.equal(challengeOnly.kind, "challenge_only");
  assert.equal(challengeOnly.challenge_score.correct_count, 4);
  assert.equal(challengeOnly.challenge_score.strikes, 2);
  assert.equal(challengeOnly.challenge_score.target, challenge.target);

  const both = courtShareSummary({
    date: "2026-08-10",
    take,
    challenge,
    beats: { take: true, challenge: true },
    streak: { current: 3 },
    consensusGate: { have: 5 },
    challengeAttempt: { status: "completed", correct_count: 4, strikes: 1 },
  });
  assert.equal(both.kind, "full_stack");
  assert.equal(both.beats.full_stack, true);
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
  assert.equal(validateTakeItems(take.items.slice(0, 2)), "take_must_have_three_items");
  assert.equal(
    validateTakeItems([{ ...take.items[0], options: [{ key: "a", label: "Only one" }] }, take.items[1], take.items[2]]),
    "invalid_take_options",
  );
});

test("player take create stays off Browse until reviewed public", () => {
  const defaults = playerTakeCreateDefaults();
  assert.deepEqual(defaults, { visibility: "unlisted", review_status: "unsubmitted" });
  assert.equal(takeIsPubliclyListed(defaults), false);
  assert.equal(takeIsPubliclyListed({ visibility: "public", review_status: "pending" }), false);
  assert.equal(takeIsPubliclyListed({ visibility: "public", review_status: "approved" }), true);
  assert.equal(takeIsPubliclyListed({ visibility: "unlisted", review_status: "approved" }), false);
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
  assert.equal(out.consensus_gate.honest_empty, true);
  assert.ok(!("visibility" in compareOut.topic));
  assert.equal(out.topic.visibility, "unlisted");
  assert.equal(takeIsPubliclyListed(out.topic), false);
});

test("player take compare requires lock first and honest empty when early", () => {
  const items = [
    {
      id: "a",
      type: "multiple_choice",
      prompt: "Pick",
      options: [{ key: "x", label: "X" }, { key: "y", label: "Y" }],
    },
    {
      id: "b",
      type: "rank",
      prompt: "Rank",
      options: [{ key: "p", label: "P" }, { key: "q", label: "Q" }],
    },
    {
      id: "c",
      type: "multiple_choice",
      prompt: "Pick 2",
      options: [{ key: "m", label: "M" }, { key: "n", label: "N" }],
    },
  ];
  const one = { answers: { a: "x", b: ["p", "q"], c: "m" } };
  const consensus = takeConsensus(items, [one]);
  const gate = { have: 1, honest_empty: true };
  assert.equal(gate.honest_empty, true);
  assert.equal(consensus[0].choices.find((ch) => ch.key === "x").count, 1);
  // Partial lock rejected (rank missing → invalid_rank_answer; MC missing → invalid_answer)
  assert.equal(normalizeTakeAnswers(items, { a: "x" }).error, "invalid_rank_answer");
  assert.equal(normalizeTakeAnswers(items, { a: "x", b: ["p", "q"] }).error, "invalid_answer");
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
