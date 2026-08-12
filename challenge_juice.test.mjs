import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const play = html.slice(html.indexOf('<div id="play" class="card hidden">'), html.indexOf('<!-- ===================== RESULTS'));

function lift(name) {
  const source = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(source, `${name} not found in index.html`);
  return source[0];
}
const missTone = new Function(`${lift("missTone")}\nreturn missTone;`)();
const boardCloseRoute = new Function(`${lift("boardCloseRoute")}\nreturn boardCloseRoute;`)();

test("a miss is grey when the mode charges nothing but time", () => {
  for (const limit of [0, null, undefined, NaN, -3]) {
    assert.equal(missTone(1, limit), "gray", `limit ${limit}`);
    assert.equal(missTone(9, limit), "gray", `limit ${limit}`);
  }
});

test("strike modes climb yellow → orange → red and the last strike is always red", () => {
  // Every mode that ships today is three strikes.
  assert.deepEqual([1, 2, 3].map((n) => missTone(n, 3)), ["yellow", "orange", "red"]);
  // The ladder scales rather than assuming three, and the top rung is the limit.
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => missTone(n, 5)), ["yellow", "orange", "orange", "red", "red"]);
  assert.deepEqual([1, 2].map((n) => missTone(n, 2)), ["orange", "red"]);
  assert.equal(missTone(1, 1), "red", "one strike and you are out reads as red immediately");
  // Overshooting the limit cannot fall off the top rung.
  assert.equal(missTone(7, 3), "red");
  // A clean board has no tone to show.
  assert.equal(missTone(0, 3), "yellow", "unused: nothing is lit at zero strikes");
});

test("each lit pip keeps the rung it was earned on", () => {
  assert.match(html, /if\(lit\) el\.classList\.add\("t-"\+missTone\(i\+1, ST\.strike_limit\)\)/);
  assert.match(html, /el\.classList\.remove\("t-yellow","t-orange","t-red"\)/);
  for (const tone of ["yellow", "orange", "red"]) {
    assert.match(html, new RegExp(`\\.strike\\.on\\.t-${tone}\\{`));
    assert.match(html, new RegExp(`\\.feed \\.m-${tone}\\{`));
  }
  assert.match(html, /\.feed \.m-gray\{color:var\(--muted\)\}/);
});

test("both graded miss lines carry the tone, and the copy inside them is unchanged", () => {
  // Roster explanation and Top 8 near-miss context, verbatim, in a toned span.
  assert.match(html, /`<span class="\$\{missClass\(r\.strikes\)\}">✕ \$\{context\} · strike \$\{r\.strikes\}\/\$\{ST\.strike_limit\}<\/span>`/);
  assert.match(html, /feed\(`<span class="\$\{missClass\(r\.strikes\)\}">✕ \$\{esc\(g\)\}\$\{ctx\} · strike \$\{r\.strikes\}\/\$\{ST\.strike_limit\}<\/span>`\)/);
  assert.match(html, /const context=esc\(f\.explanation\|\|fallback\)/);
  assert.match(html, /ctx=` — \$\{val\} \$\{gi\.unit\}, #\$\{gi\.rank\} all-time`/);
  // A transport error is not a graded miss, so it stays plain red.
  assert.match(html, /feed\(`<span class="x">\$\{esc\(g\)\} → \$\{esc\(r\.error\)\}<\/span>`\)/);
});

test("a correct name lands through the reels, and the reels never show another name", () => {
  assert.match(html, /revealSlotName\(el, r\.display_name, land\)/);
  const reveal = html.match(/function revealSlotName\([\s\S]*?\n\}/)[0];
  // Scrambled glyphs of the landing name — POOL is never read here, which is
  // what keeps Top 8 (whose suggest pool is the answer pool) leak-free.
  assert.match(reveal, /REEL_GLYPHS\[Math\.floor\(Math\.random\(\)\*REEL_GLYPHS\.length\)\]/);
  assert.doesNotMatch(reveal, /POOL/);
  // Locks left to right and is over quickly.
  assert.match(reveal, /const locked=Math\.floor\(chars\.length\*tick\/REEL_TICKS\)/);
  assert.match(reveal, /i<locked/);
  const ticks = Number(html.match(/REEL_TICKS=(\d+)/)[1]);
  const ms = Number(html.match(/REEL_MS=(\d+)/)[1]);
  assert.ok(ticks * ms <= 500, `reveal runs ${ticks * ms}ms, which is not brief`);
  // The rarity badge is HTML, so the real markup is written once, at the end.
  assert.match(reveal, /clearInterval\(int\);[\s\S]*land\(\);/);
});

test("reduced motion drops the travel and keeps the state", () => {
  assert.match(html, /const reduceMotion = \(\) => !!\(window\.matchMedia && window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches\)/);
  // No reels: the name lands immediately, still green, still filled.
  assert.match(html, /if\(!name \|\| reduceMotion\(\) \|\| !finalText\)\{ land\(\); return; \}/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)\{\s*\n?\s*\.closed\{animation:none\} \.slot\.landed\{animation:none\}/);
  // Colour, fill and the strip are all plain CSS state, not animation.
  assert.match(html, /\.slot\.filled\{border-color:var\(--good\)/);
  assert.match(html, /\.closed\.win\{border-color:var\(--good\)/);
});

test("every finish runs the same hush: freeze, disable, strip, hold, navigate", () => {
  const close = html.match(/function closeBoard\(r\)\{[\s\S]*?\n\}/)[0];
  assert.match(close, /clearInterval\(timerInt\); timerInt=null/);
  assert.match(close, /\$\("timer"\)\.textContent=fmt\(r\.elapsed_ms\)/);
  assert.match(close, /\$\("guessInput"\)\.disabled=true/);
  assert.match(close, /\$\("guessBtn"\)\.disabled=true/);
  assert.match(close, /<div class="ttl">Board closed<\/div><div class="sum">\$\{n\} of \$\{ST\.answer_target\} named · \$\{fmt\(ms\)\}<\/div>/);
  assert.match(close, /}, BOARD_CLOSE_MS\)/);
  assert.match(html, /const BOARD_CLOSE_MS=1200/);
  // Both finish paths route through it; neither keeps its old ad-hoc timeout.
  assert.match(html, /if\(r\.finished\) closeBoard\(r\); else \$\("guessInput"\)\.focus\(\)/);
  assert.match(html, /feed\(r\.status==="completed"\?[\s\S]*?\);\s*\n\s*closeBoard\(r\);/);
  assert.doesNotMatch(html, /setTimeout\(showResults,900\)/);
  assert.doesNotMatch(html, /setTimeout\(showResults,ST\.isCourtDaily\?1800:900\)/);
  // The strip is full width, between the board and the (now dead) input.
  assert.match(play, /<div id="boardClosed" class="closed hidden" role="status"/);
  assert.ok(play.indexOf('id="slots"') < play.indexOf('id="boardClosed"'));
  assert.ok(play.indexOf('id="boardClosed"') < play.indexOf('id="guessInput"'));
});

test("a closed board routes to the Daily recap only on a full stack", () => {
  assert.equal(boardCloseRoute({ isCourtDaily: true, beats: { take: true, challenge: true, full_stack: true } }), "daily_recap");
  // Challenge first, Take still open: there is no stack to recap yet.
  assert.equal(boardCloseRoute({ isCourtDaily: true, beats: { challenge: true, full_stack: false } }), "results");
  assert.equal(boardCloseRoute({ isCourtDaily: true, beats: null }), "results");
  assert.equal(boardCloseRoute({ isCourtDaily: false, beats: { full_stack: true } }), "results");
  assert.equal(boardCloseRoute(), "results");
  assert.match(html, /if\(route==="daily_recap"\) openDaily\(ST\.courtDate\|\|COURT\.date\); else showResults\(\)/);
  // beats are refreshed from the graded response before the route is taken.
  assert.match(html, /if\(r\.beats\) COURT\.beats=r\.beats;[\s\S]*applyGuessToBoard\(r\)/);
});

test("reopening a board takes the hush back down", () => {
  assert.match(html, /function openBoardInput\(\)\{[\s\S]*\$\("guessInput"\)\.disabled=false; \$\("guessBtn"\)\.disabled=false;[\s\S]*\$\("boardClosed"\)\.className="closed hidden"/);
  // buildBoard is the one door into a live board — fresh, resumed, or restarted.
  assert.match(html, /openBoardInput\(\);   \/\/ every entry to a live board comes through here/);
  const build = html.match(/function buildBoard\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(build, /openBoardInput\(\)/);
  for (const entry of [/buildBoard\(\); renderPlay\(\); show\("play"\);/, /buildBoard\(\); renderPlay\(\);\s*\n\s*\$\("guessInput"\)\.value=""/]) {
    assert.match(html, entry);
  }
});

test("server grading, strike counts and timer authority are untouched", () => {
  // The client still takes strikes, fill and elapsed time from the response.
  assert.match(html, /ST\.filled=r\.filled_slots\|\|ST\.filled; ST\.strikes=r\.strikes; ST\.correct=r\.correct_count/);
  assert.match(html, /\$\("timer"\)\.textContent=fmt\(Date\.now\(\)-ST\.startedMs\)/);
  assert.match(html, /ST\.startedMs = r\.started_at \? new Date\(r\.started_at\)\.getTime\(\) : Date\.now\(\)/);
  // No client-side finishing: closeBoard only ever runs off r.finished.
  const submit = html.match(/async function submitGuess\(\)\{[\s\S]*?\n\}/)[0];
  assert.equal((submit.match(/closeBoard\(r\)/g) || []).length, 2);
  assert.doesNotMatch(submit, /ST\.finished=true[^;]*;\s*closeBoard/);
});
