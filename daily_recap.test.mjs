import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HOUSE_TAKE_ROTATION,
  dailyChallengeForDate,
  hardestCorrectPick,
  houseTakeForDate,
  nextCourtDate,
  tomorrowTease,
} from "./supabase/functions/mp/court_contract.js";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const court = readFileSync(new URL("./supabase/functions/mp/court.ts", import.meta.url), "utf8");
const consensusCard = html.slice(html.indexOf('<div id="courtConsensus" class="card hidden">'), html.indexOf('<!-- ===================== PLAYER TAKE'));

function lift(name) {
  // One-liners first: a lazy multi-line match would run past the end of a
  // single-line function and swallow whatever is declared after it.
  const single = html.match(new RegExp(`^function ${name}\\(.*\\}$`, "m"));
  if (single) return single[0];
  const source = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(source, `${name} not found in index.html`);
  return source[0];
}
const api = new Function(`${lift("courtSurfaceMode")}\n${lift("courtDayLabel")}\n${lift("challengeRecapStat")}\n` +
  `${html.match(/const SHARE_MONTHS=\[[^\]]*\];/)[0]}\nreturn { courtSurfaceMode, courtDayLabel, challengeRecapStat };`)();
const { courtSurfaceMode, courtDayLabel, challengeRecapStat } = api;

const fills = (...rows) => Object.fromEntries(rows.map(([slot, name, rarity_tier, at_ms]) => [String(slot), { name, player_key: name, rarity_tier, at_ms }]));

test("the recap is a state of the consensus surface, not a second screen", () => {
  assert.equal(courtSurfaceMode({ take: true, challenge: true, full_stack: true }), "recap");
  // Take locked, Challenge still open: the same card has to keep offering it.
  assert.equal(courtSurfaceMode({ take: true, challenge: false, full_stack: false }), "consensus");
  assert.equal(courtSurfaceMode({ challenge: true, full_stack: false }), "consensus");
  assert.equal(courtSurfaceMode({}), "consensus");
  assert.equal(courtSurfaceMode(null), "consensus");
  assert.equal(courtSurfaceMode(undefined), "consensus");
  // One card, four sections, all of them in the DOM at all times.
  for (const id of ["courtSecChallenge", "courtSecTomorrow", "courtSecTakeHdr", "courtSecShareHdr"]) {
    assert.match(consensusCard, new RegExp(`id="${id}"`));
  }
  for (const stage of [1, 2, 3, 4]) assert.match(consensusCard, new RegExp(`--stage:${stage}`));
});

test("recap chrome says recap, and mid-flow chrome does not", () => {
  const render = lift("renderCourtConsensus");
  assert.match(render, /\$\("courtConsensusPill"\)\.textContent=recap\?"Daily recap":"Take locked"/);
  // Date-forward title.
  assert.match(render, /\$\{day\?day\+" · ":""\}Full stack/);
  assert.equal(courtDayLabel("2026-08-12"), "Aug 12");
  assert.equal(courtDayLabel("2026-01-01"), "Jan 1");
  assert.equal(courtDayLabel("2026-12-31"), "Dec 31");
  // Parsed by field: no Date, so the label cannot slip a day in a timezone.
  assert.doesNotMatch(lift("courtDayLabel"), /new Date/);
  for (const junk of ["", null, undefined, "tomorrow", "2026-8-1"]) assert.equal(courtDayLabel(junk), null);
  // Streak reads proud but calm, and stays silent at zero.
  assert.match(render, /s\.streak>0\?`🔥 \$\{s\.streak\} day streak`:"Both beats done\."/);
  // Both beats on the rail.
  assert.match(render, /dailyProgressHtml\(\{takeAnswered:3,challengeCorrect:COURT\.challenge_attempt\?\.correct_count\|\|0/);
  assert.match(render, /\$\("courtRecapRail"\)\.classList\.toggle\("hidden", !recap\)/);
});

test("a finished stack offers no Start Challenge, and mid-flow still does", () => {
  const render = lift("renderCourtConsensus");
  // The button survives as a way back to the board, demoted; Share is the action.
  assert.match(render, /\$\("courtChallengeStart"\)\.classList\.toggle\("ghost", recap\)/);
  assert.match(render, /\$\("courtSkipChallenge"\)\.classList\.toggle\("hidden", recap\)/);
  // Its label is already Review Challenge whenever the board is closed.
  assert.match(render, /\$\("courtChallengeStart"\)\.textContent="Review Challenge"/);
  assert.match(render, /\$\("courtChallengeStart"\)\.textContent="Start Challenge"/);
  // Sections that only make sense once there are four of them.
  assert.match(render, /\$\("courtSecTakeHdr"\)\.classList\.toggle\("hidden", !recap\)/);
  assert.match(render, /\$\("courtSecTomorrow"\)\.classList\.toggle\("hidden", !recap\)/);
  // Section 2 is gated on there being a Challenge to report, not on the mode.
  assert.match(render, /\$\("courtSecChallenge"\)\.classList\.toggle\("hidden", !\(COURT\.beats&&COURT\.beats\.challenge\)\)/);
});

test("section 1 keeps the rich distributions and the room story", () => {
  const render = lift("renderCourtConsensus");
  assert.match(render, /renderRoomStory\(rows\)/);
  assert.match(render, /takeBlockHtml\(row, COURT\.answers\[row\.item_id\]\)/);
  // Both live inside section 1, above the Challenge section.
  assert.ok(consensusCard.indexOf('id="courtRoomStory"') < consensusCard.indexOf('id="courtSecChallenge"'));
  assert.ok(consensusCard.indexOf('id="courtConsensusRows"') < consensusCard.indexOf('id="courtSecChallenge"'));
});

test("section 2 states the board's numbers and claims cleared only on a filled board", () => {
  assert.deepEqual(challengeRecapStat({ correct: 5, target: 5, strikes: 1, status: "completed" }),
    { score: "5 of 5", strikes: 1, cleared: true, verdict: "Cleared" });
  // Completed but short is not cleared — nor is a zero target.
  assert.equal(challengeRecapStat({ correct: 3, target: 5, status: "completed" }).cleared, false);
  assert.equal(challengeRecapStat({ correct: 0, target: 0, status: "completed" }).cleared, false);
  assert.equal(challengeRecapStat({ correct: 2, target: 5, strikes: 3, status: "eliminated" }).verdict, "Struck out");
  assert.equal(challengeRecapStat({ correct: 2, target: 5, status: "expired" }).verdict, "Out of time");
  assert.equal(challengeRecapStat({ correct: 1, target: 5, status: "in_progress" }).verdict, "In progress");
  assert.equal(challengeRecapStat({}).verdict, "Closed");
  assert.equal(challengeRecapStat({}).score, "0 of 0");
  // Time comes from the server's elapsed_ms through the existing formatter.
  const summary = lift("renderCourtChallengeSummary");
  assert.match(summary, /Number\.isFinite\(att\.elapsed_ms\)\?fmt\(att\.elapsed_ms\):"—"/);
  assert.match(summary, /<div class="lbl">Named<\/div>/);
  assert.match(summary, /<div class="lbl">Time<\/div>/);
  assert.match(summary, /<div class="lbl">Strikes<\/div>/);
  assert.match(court, /elapsed_ms: state\.challengeAttempt\.elapsed_ms \?\? null/);
  assert.match(court, /started_at, finished_at, elapsed_ms, ranking_time_ms, correct_count, strikes, filled_slots/);
});

test("the hardest pick is read off the board that was played, never invented", () => {
  // Rarity first.
  const byRarity = hardestCorrectPick(fills(
    [1, "Common Guy", "common", 4000],
    [2, "Deep Cut", "deep_cut", 9000],
    [3, "Rare One", "rare", 12000]));
  assert.equal(byRarity.name, "Deep Cut");
  assert.equal(byRarity.rarity_tier, "deep_cut");
  // Then the longest gap before it landed — so on an all-Common board the stat
  // is still true: it is the one that took longest to come to you.
  const byGap = hardestCorrectPick(fills(
    [1, "First", "common", 2000],
    [2, "Slow", "common", 30000],
    [3, "Quick", "common", 31000]));
  assert.equal(byGap.name, "Slow");
  assert.equal(byGap.took_ms, 28000);
  // Under two fills there is nothing for a pick to be harder THAN.
  assert.equal(hardestCorrectPick(fills([1, "Only", "deep_cut", 3000])), null);
  assert.equal(hardestCorrectPick({}), null);
  assert.equal(hardestCorrectPick(null), null);
  assert.equal(hardestCorrectPick(undefined), null);
  // Rows without a name are not answers.
  assert.equal(hardestCorrectPick({ 1: { name: "A", rarity_tier: "common", at_ms: 1 }, 2: { player_key: "x" } }), null);
  // A missing tier does not outrank a real one, and a missing at_ms is survivable.
  const untiered = hardestCorrectPick({ 1: { name: "A", at_ms: 1000 }, 2: { name: "B", rarity_tier: "uncommon" } });
  assert.equal(untiered.name, "B");
  // Ties fall back to the earliest slot, so the stat is stable across renders.
  const tied = hardestCorrectPick(fills([1, "A", "rare", 1000], [2, "B", "rare", 2000]));
  assert.equal(hardestCorrectPick(fills([1, "A", "rare", 1000], [2, "B", "rare", 2000])).name, tied.name);
  // Server-side, read only off the caller's own attempt.
  assert.match(court, /hardest_pick: hardestCorrectPick\(state\.challengeAttempt\.filled_slots \?\? \{\}\)/);
  // Client renders it with the existing rarity badge, and stays quiet on null.
  const summary = lift("renderCourtChallengeSummary");
  assert.match(summary, /hp&&hp\.name \? `<div class="hardest">The hardest pick to get was <b>\$\{esc\(hp\.name\)\}<\/b>/);
  assert.match(summary, /rarBadge\(\{rarity_tier:hp\.rarity_tier,rarity_label:label\}\)/);
});

test("section 3 is the #14 text share card, unchanged", () => {
  assert.match(consensusCard, /<div class="sec-hdr hidden" id="courtSecShareHdr">Share<\/div>/);
  assert.match(consensusCard, /id="courtShareCard"[\s\S]*id="courtShareText"[\s\S]*id="courtShareBtn"/);
  const render = lift("renderCourtConsensus");
  assert.match(render, /renderCourtShare\("courtShare", COURT\.share\)/);
  const share = lift("renderCourtShare");
  assert.match(share, /\$\(prefix\+"Text"\)\.textContent=courtShareText\(summary\)/);
  const contract = readFileSync(new URL("./supabase/functions/mp/court_contract.js", import.meta.url), "utf8");
  assert.match(contract, /export const COURT_SHARE_CTA = "Enter the Court of Public Opinion"/);
});

test("tomorrow is teased from the subject only, never from the board", () => {
  assert.equal(nextCourtDate("2026-08-12"), "2026-08-13");
  assert.equal(nextCourtDate("2026-12-31"), "2027-01-01");
  assert.equal(nextCourtDate("2026-02-28"), "2026-03-01");
  for (const junk of ["", null, "2026-8-1", "nope"]) assert.equal(nextCourtDate(junk), null);

  // Over a full turn of both rotations, every tease is a wonder, is about
  // tomorrow, and gives away nothing that is on tomorrow's board.
  const seen = new Set();
  for (let i = 0; i < 42; i++) {
    const date = nextCourtDate(`2026-08-${String((i % 28) + 1).padStart(2, "0")}`);
    const today = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    const tease = tomorrowTease(today);
    assert.ok(tease, `no tease for ${today}`);
    assert.equal(tease.date, date);
    assert.match(tease.line, /^Hmm I wonder .+\?$/);
    seen.add(tease.line);
    const take = houseTakeForDate(date);
    const challenge = dailyChallengeForDate(date);
    // No option labels — a Take option is an answer someone is about to choose.
    for (const item of take.items) {
      for (const option of item.options) {
        assert.ok(!tease.line.includes(option.label), `${tease.line} leaks ${option.label}`);
      }
      assert.ok(!tease.line.includes(item.prompt), "a prompt is the board, not a tease");
    }
    // No target count and no position: the ask stays unopened.
    assert.doesNotMatch(tease.line, new RegExp(`\\b${challenge.target}\\b`));
    for (const noun of ["guards", "forwards", "centers"]) assert.ok(!tease.line.includes(noun));
    assert.ok(!tease.line.includes(challenge.prompt));
  }
  // It varies rather than repeating one line forever.
  assert.ok(seen.size >= 4, `only ${seen.size} distinct teases across the rotation`);

  // Stable for a given day: a recap can be reopened, so no randomness.
  assert.equal(tomorrowTease("2026-08-12").line, tomorrowTease("2026-08-12").line);
  assert.doesNotMatch(lift("renderCourtConsensus"), /Math\.random/);

  // Pure from the date — no row is created for tomorrow, which would freeze
  // content nobody has played.
  const contract = readFileSync(new URL("./supabase/functions/mp/court_contract.js", import.meta.url), "utf8");
  const fn = contract.match(/export function tomorrowTease[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(fn, /db\.|await |getOrCreateCourtDay/);
  assert.match(court, /tomorrow: tomorrowTease\(courtDay\.day\)/);
  // Both generators it leans on really are pure functions of the date.
  assert.equal(JSON.stringify(houseTakeForDate("2026-08-13")), JSON.stringify(houseTakeForDate("2026-08-13")));
  assert.ok(HOUSE_TAKE_ROTATION.length >= 3);
});

test("section 4 says when the next one lands, and only in recap", () => {
  assert.match(consensusCard, /<div class="note">New Court drops tomorrow\.<\/div>/);
  assert.match(consensusCard, /<div class="tease" id="courtTomorrowTease"><\/div>/);
  const render = lift("renderCourtConsensus");
  assert.match(render, /\$\("courtTomorrowTease"\)\.textContent=recap&&tease\?tease:""/);
  assert.match(html, /tomorrow:r\.tomorrow\|\|null/);
});

test("the entrance plays once on landing and is not load-bearing", () => {
  const play = lift("playRecapEntrance");
  assert.match(play, /card\.classList\.remove\("staged"\)/);
  assert.match(play, /if\(courtSurfaceMode\(COURT\.beats\)!=="recap" \|\| reduceMotion\(\)\) return/);
  assert.match(play, /void card\.offsetWidth; card\.classList\.add\("staged"\)/);
  assert.match(play, /recapEntranceTimer=setTimeout\(\(\)=>card\.classList\.remove\("staged"\),1200\)/);
  // openDaily is the landing — Review Your Daily and the last finished beat both
  // come through it, and a re-render (Refresh reloads the day) is a new landing
  // while an in-page re-render is not.
  assert.match(html, /playRecapEntrance\(\);/);
  assert.doesNotMatch(lift("renderCourtConsensus"), /playRecapEntrance/);
  // Sections are visible without the animation; reduced motion drops it entirely.
  assert.match(html, /\.staged \.recap-sec\{animation:secIn \.34s ease-out both;animation-delay:calc\(var\(--stage,1\) \* 110ms\)\}/);
  const reduced = html.match(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\n  \}/)[0];
  assert.match(reduced, /\.staged \.recap-sec\{animation:none\}/);
});

test("Review Your Daily routes to the recap, and a Take-only day does not", () => {
  // Home's full-stack CTA is the recap's front door and still says so.
  assert.match(html, /if\(b\.full_stack\) return \{ state:"full_stack", cta:"Review Your Daily", note:"See your recap and share card\." \}/);
  assert.match(html, /\$\("dailyBtn"\)\.onclick=\(\)=>openDaily\(\)/);
  // Both routes into the surface land through openDaily's tail.
  const open = html.match(/async function openDaily\(dayOpt\)\{[\s\S]*?\n\}/)[0];
  assert.match(open, /renderCourtConsensus\(\); show\("courtConsensus"\);\s*\n[\s\S]{0,220}?playRecapEntrance\(\);/);
  // A finished board with the stack complete is routed here by #18, unchanged.
  assert.match(html, /if\(route==="daily_recap"\) openDaily\(ST\.courtDate\|\|COURT\.date\); else showResults\(\)/);
  // Mid-flow after the Take only still reaches the Challenge-ready consensus.
  assert.match(html, /if\(!item\)\{ renderCourtConsensus\(\); show\("courtConsensus"\); return; \}/);
  assert.match(html, /if\(f\.take_complete\)\{\s*\n\s*if\(COURT\.beats\?\.challenge\)\{ await openDaily\(COURT\.date\); return; \}\s*\n\s*await startCourtChallenge\(\); return;/);
});
