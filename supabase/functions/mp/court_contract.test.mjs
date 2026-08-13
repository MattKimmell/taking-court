import assert from "node:assert/strict";
import test from "node:test";
import {
  challengeShareAsk,
  courtContinueRoute,
  courtShareDate,
  courtToken,
  COURT_SHARE_CTA,
  dailyChallengeForDate,
  courtShareSummary,
  questionize,
  takeShareQuestion,
  crewCanRevealTakes,
  crewChallengeOnlySocialNote,
  crewDayMatchesSolo,
  crewHottestTakeEligible,
  crewMemberCourtFlags,
  dayCountsForStreak,
  frozenChallengePublicFields,
  HOME_CHROME,
  homeHasPeerModePicker,
  houseTakeForDate,
  normalizeTakeAnswers,
  normalizeTakeItemAnswer,
  playerTakeCreateDefaults,
  playerTakeLockOut,
  takeCourtBeats,
  takeConsensus,
  takeItemLockPlan,
  takeProgress,
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

test("per-item Take locks are sequential, immutable, and idempotent", () => {
  const take = houseTakeForDate("2026-08-10");
  const first = take.items[0];
  const second = take.items[1];
  const answerFor = (item) => item.type === "rank" ? item.options.map((o) => o.key) : item.options[0].key;
  assert.equal(normalizeTakeItemAnswer(first, answerFor(first)).error, null);
  assert.equal(takeItemLockPlan(take.items, {}, second.id, answerFor(second)).error, "take_item_out_of_order");
  const lock = takeItemLockPlan(take.items, {}, first.id, answerFor(first));
  assert.equal(lock.error, null);
  assert.equal(lock.idempotent, false);
  assert.equal(takeItemLockPlan(take.items, lock.answers, first.id, answerFor(first)).idempotent, true);
  const changed = first.type === "rank" ? answerFor(first).slice().reverse() : first.options[1].key;
  assert.equal(takeItemLockPlan(take.items, lock.answers, first.id, changed).error, "take_answer_locked");
});

test("partial Take progress never reports completion without completed_at", () => {
  const take = houseTakeForDate("2026-08-10");
  const answers = { [take.items[0].id]: take.items[0].type === "rank" ? take.items[0].options.map((o) => o.key) : take.items[0].options[0].key };
  const partial = takeProgress(take.items, answers, null);
  assert.deepEqual(partial.answered_item_ids, [take.items[0].id]);
  assert.equal(partial.next_item_id, take.items[1].id);
  assert.equal(partial.completed, false);
  const all = Object.fromEntries(take.items.map((item) => [item.id, item.type === "rank" ? item.options.map((o) => o.key) : item.options[0].key]));
  assert.equal(takeProgress(take.items, all, null).completed, false);
  assert.equal(takeProgress(take.items, all, "2026-08-10T12:00:00Z").completed, true);
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
  assert.ok(consensus.some((row) => row.type === "rank" && row.ranking[0].top_pct === 100));
  assert.ok(consensus.some((row) => row.type === "multiple_choice" && row.choices[0].count === 1 && row.choices[0].pct === 100));
});

test("consensus totals count only players who answered that item", () => {
  const take = houseTakeForDate("2026-08-10");
  const item = take.items.find((i) => i.type === "multiple_choice");
  const rows = [
    { answers: { [item.id]: item.options[0].key } },
    { answers: {} },
    { answers: { [item.id]: item.options[1].key } },
  ];
  const row = takeConsensus([item], rows)[0];
  assert.equal(row.total, 2);
  assert.equal(row.choices.reduce((n, choice) => n + choice.count, 0), 2);
  assert.equal(row.choices.reduce((n, choice) => n + choice.pct, 0), 100);
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
  assert.match(full.text, /^Enter the Court of Public Opinion\n\n/);
  assert.ok(full.text.endsWith("Taking Court · Aug 10 · 🔥 4"));
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
  assert.equal(takeOnly.take_question, takeShareQuestion(take));
  assert.equal(takeOnly.challenge_ask, null);
  assert.ok(!takeOnly.text.includes(challenge.prompt));

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

test("the Daily share card leads on the invite, then the questions, then the signature", () => {
  const take = houseTakeForDate("2026-08-10");
  const challenge = dailyChallengeForDate("2026-08-10");
  const full = courtShareSummary({
    date: "2026-08-10",
    take,
    challenge,
    beats: { take: true, challenge: true },
    streak: { current: 3 },
    consensusGate: { have: 5 },
    challengeAttempt: { status: "completed", correct_count: challenge.target, strikes: 1 },
  });
  assert.equal(full.text, [
    "Enter the Court of Public Opinion",
    "",
    takeShareQuestion(take),
    `${challengeShareAsk(challenge)} ✓`,
    "",
    "Taking Court · Aug 10 · 🔥 3",
  ].join("\n"));
  // The CTA is exact and opens the card; the caller appends the link after the
  // signature, which is why nothing here ends on it.
  assert.equal(full.cta, COURT_SHARE_CTA);
  assert.ok(full.text.startsWith(`${COURT_SHARE_CTA}\n`));
  assert.equal(full.path, "?court=1&day=2026-08-10");
});

test("the share card previews questions and never the player's answers", () => {
  const take = houseTakeForDate("2026-08-10");
  const challenge = dailyChallengeForDate("2026-08-10");
  const full = courtShareSummary({
    date: "2026-08-10",
    take,
    challenge,
    beats: { take: true, challenge: true },
    streak: { current: 1 },
    consensusGate: { have: 5 },
    challengeAttempt: { status: "completed", correct_count: challenge.target, strikes: 0 },
  });
  // Exactly one line from the Take, not all three prompts.
  for (const item of take.items.slice(1)) assert.ok(!full.text.includes(item.prompt));
  // No option label — the player's locked choices are answers, not the ask.
  for (const item of take.items) {
    for (const option of item.options) assert.ok(!full.text.includes(option.label));
  }
  // No score line: a count of the board is a fact about the answers.
  assert.doesNotMatch(full.text, /\d+\s*\/\s*\d+/);
  assert.match(full.text, /^Can you name \d+ (guards|forwards|centers) who /m);
});

test("the success mark is a claim about the board, so it needs a filled board", () => {
  const take = houseTakeForDate("2026-08-10");
  const challenge = dailyChallengeForDate("2026-08-10");
  const share = (challengeAttempt) => courtShareSummary({
    date: "2026-08-10", take, challenge, beats: { take: true, challenge: true },
    streak: { current: 0 }, consensusGate: { have: 1 }, challengeAttempt,
  });

  const cleared = share({ status: "completed", correct_count: challenge.target, strikes: 1 });
  assert.equal(cleared.challenge_cleared, true);
  assert.ok(cleared.text.includes(`${challengeShareAsk(challenge)} ✓`));

  const short = share({ status: "completed", correct_count: challenge.target - 1, strikes: 3 });
  assert.equal(short.challenge_cleared, false);
  assert.ok(short.text.includes(challengeShareAsk(challenge)));
  assert.ok(!short.text.includes("✓"));
});

test("kinded share cards carry only the beats the player earned", () => {
  const take = houseTakeForDate("2026-08-10");
  const challenge = dailyChallengeForDate("2026-08-10");
  const base = {
    date: "2026-08-10", take, challenge, streak: { current: 0 }, consensusGate: { have: 1 },
    challengeAttempt: { status: "completed", correct_count: challenge.target, strikes: 0 },
  };

  const takeOnly = courtShareSummary({ ...base, beats: { take: true, challenge: false } });
  assert.equal(takeOnly.text, [
    COURT_SHARE_CTA, "", takeShareQuestion(take), "", "Taking Court · Aug 10",
  ].join("\n"));

  const challengeOnly = courtShareSummary({ ...base, beats: { take: false, challenge: true } });
  assert.equal(challengeOnly.text, [
    COURT_SHARE_CTA, "", `${challengeShareAsk(challenge)} ✓`, "", "Taking Court · Aug 10",
  ].join("\n"));

  // Streak is a signal, not decoration: it appears only when there is one, and
  // it rides on the signature line rather than taking one of its own.
  assert.ok(!takeOnly.text.includes("🔥"));
  assert.ok(
    courtShareSummary({ ...base, beats: { take: true, challenge: false }, streak: { current: 7 } }).text
      .endsWith("Taking Court · Aug 10 · 🔥 7"),
  );
});

test("share dates read by field so the line cannot drift a day", () => {
  assert.equal(courtShareDate("2026-08-12"), "Aug 12");
  assert.equal(courtShareDate("2026-01-01"), "Jan 1");
  assert.equal(courtShareDate("2026-12-31"), "Dec 31");
  assert.equal(courtShareDate("not-a-day"), null);
  assert.equal(courtShareDate(undefined), null);
});

test("questionize poses an ask without inventing words", () => {
  assert.equal(questionize("Who is the worst matchup?"), "Who is the worst matchup?");
  assert.equal(questionize("Name 5 guards who played for the Lakers."), "Can you name 5 guards who played for the Lakers?");
  assert.equal(questionize("  Rank these players  "), "Can you rank these players?");
  assert.equal(questionize(""), null);
  assert.equal(questionize(null), null);
});

test("the Take question prefers authored copy and falls back to the first item", () => {
  const authored = houseTakeForDate("2026-08-10");
  assert.ok(authored.share_question, "rotation takes carry a share question");
  assert.equal(takeShareQuestion(authored), authored.share_question);

  // A day snapshotted before share_question existed still poses a question.
  const legacy = { title: "Legacy court", items: authored.items };
  assert.equal(takeShareQuestion(legacy), questionize(authored.items[0].prompt));
  assert.ok(takeShareQuestion(legacy).endsWith("?"));

  // Nothing usable at all falls back to the title rather than inventing a question.
  assert.equal(takeShareQuestion({ title: "Barbershop ballot", items: [] }), "Barbershop ballot");
  assert.equal(takeShareQuestion({}), null);
});

test("the Challenge ask is built from the definition, matching the played prompt", () => {
  assert.equal(
    challengeShareAsk({ axis: "team", value: "LAL", position: "G", target: 5 }),
    "Can you name 5 guards who played for the Lakers?",
  );
  assert.equal(
    challengeShareAsk({ axis: "college", value: "Duke", position: "F", target: 4 }),
    "Can you name 4 forwards who went to Duke?",
  );
  // Filter-built or older definitions carry only a prompt.
  assert.equal(
    challengeShareAsk({ prompt: "Name 3 centers who played for the Bulls." }),
    "Can you name 3 centers who played for the Bulls?",
  );
  assert.equal(challengeShareAsk({}), null);
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

test("crew same-day identity matches solo Daily Court token and date", () => {
  const date = "2026-08-11";
  const token = courtToken(date);
  assert.equal(
    crewDayMatchesSolo({
      crewDate: date,
      soloDate: date,
      crewShareToken: token,
      soloShareToken: token,
    }),
    true,
  );
  assert.equal(
    crewDayMatchesSolo({
      crewDate: date,
      soloDate: "2026-08-10",
      crewShareToken: token,
      soloShareToken: courtToken("2026-08-10"),
    }),
    false,
  );
  assert.equal(
    crewDayMatchesSolo({
      crewDate: date,
      soloDate: date,
      crewShareToken: "court_other",
      soloShareToken: token,
    }),
    false,
  );
});

test("crew hottest-take eligible only with reveal + 2+ Take locks; Challenge-only noted", () => {
  assert.equal(crewHottestTakeEligible({ revealTakes: false, takeLockCount: 5 }), false);
  assert.equal(crewHottestTakeEligible({ revealTakes: true, takeLockCount: 1 }), false);
  assert.equal(crewHottestTakeEligible({ revealTakes: true, takeLockCount: 2 }), true);
  assert.equal(crewChallengeOnlySocialNote({ challengeOnlyCount: 0, takeLockCount: 2 }), null);
  assert.match(
    crewChallengeOnlySocialNote({ challengeOnlyCount: 2, takeLockCount: 0 }),
    /Challenge only/,
  );
  assert.match(
    crewChallengeOnlySocialNote({ challengeOnlyCount: 1, takeLockCount: 3 }),
    /hottest Take uses locked Takes only/,
  );
  // Challenge-only member still played_today via crewMemberCourtFlags
  assert.equal(crewMemberCourtFlags({ takeDone: false, challengeDone: true }).played_today, true);
});

test("home IA has no peer mode picker and uses Daily Court glossary", () => {
  assert.equal(homeHasPeerModePicker(), false);
  assert.equal(HOME_CHROME.product, "Daily Court");
  assert.equal(HOME_CHROME.primaryCta, "Play Now");
  assert.deepEqual(HOME_CHROME.beats, ["Take", "Challenge"]);
  assert.ok(HOME_CHROME.secondary.includes("Pickup"));
  assert.ok(HOME_CHROME.secondary.includes("Crew"));
  assert.ok(HOME_CHROME.quiet.includes("Create Take"));
  assert.ok(HOME_CHROME.quiet.includes("Freeplay"));
  assert.match(HOME_CHROME.join, /link or token/i);
  assert.equal(HOME_CHROME.freeplayLabels.top8, "Top 8 / recall");
  // Old top-level product names are not home peers
  assert.ok(!HOME_CHROME.secondary.includes("Name It"));
  assert.ok(!HOME_CHROME.secondary.includes("Tier Lists"));
  assert.ok(!HOME_CHROME.secondary.includes("Your Lists"));
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
