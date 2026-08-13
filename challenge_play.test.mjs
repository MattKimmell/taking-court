import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const play = html.slice(html.indexOf('<div id="play" class="card hidden">'), html.indexOf('<!-- ===================== RESULTS'));

// The drop rule is the part worth exercising rather than pattern-matching, so
// feedPush is pure and gets lifted out of the file and run for real.
function lift(name) {
  const source = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n?\\}`));
  assert.ok(source, `${name} not found in index.html`);
  return source[0];
}
const feedPush = new Function(`const FEED_DEPTH=2;\n${lift("feedPush")}\nreturn feedPush;`)();

test("the ask is the primary focal text on the play surface", () => {
  // Eyebrow, prompt, quiet meta — one box, above everything else on the board.
  assert.match(play, /<div class="askbox">\s*<div class="eb" id="playCat">[\s\S]*<div class="aq" id="playPrompt">[\s\S]*<div class="am" id="playMeta">/);
  assert.ok(play.indexOf('id="playPrompt"') < play.indexOf('class="statusrow"'), "the ask precedes the status row");
  assert.ok(play.indexOf('class="statusrow"') < play.indexOf('id="slots"'), "the status row precedes the board");
  // The old duel-pill-plus-heading arrangement is gone.
  assert.doesNotMatch(play, /class="pill" id="playCat"/);
  assert.doesNotMatch(play, /id="playPrompt"[^>]*font-size:16px/);
  // Largest type on this surface belongs to the ask.
  assert.match(html, /#play \.askbox \.aq\{font-size:17px\}/);
});

test("the eyebrow names the mode the player thinks they opened", () => {
  assert.match(html, /\$\("playCat"\)\.textContent = ST\.isCourtDaily \? "Daily Challenge"/);
  assert.match(html, /\$\("playMeta"\)\.textContent = `Name \$\{ST\.answer_target\} · \$\{ST\.strike_limit\} strikes`/);
});

test("strikes, fill and time share one status row, and the timer is no longer the loudest element", () => {
  assert.match(play, /<div class="stat"><span class="lbl">Strikes<\/span><div class="strikes" id="strikeRow">/);
  assert.match(play, /<div class="stat"><span class="lbl">Filled<\/span><div class="val" id="playFill">/);
  assert.match(play, /<div class="stat"><span class="lbl">Time<\/span><div class="val timer" id="timer">/);
  // Timer keeps its 100ms tick and its exact finish value; it just isn't 30px.
  const timerCss = html.match(/\.timer\{[^}]*\}/)[0];
  assert.match(timerCss, /font-size:16px/);
  assert.doesNotMatch(timerCss, /font-size:30px/);
  assert.match(html, /setInterval\(\(\)=>\{[\s\S]*\$\("timer"\)\.textContent=fmt\(Date\.now\(\)-ST\.startedMs\)[\s\S]*\},100\)/);
  assert.match(html, /\$\("timer"\)\.textContent=fmt\(r\.elapsed_ms\)/);
});

test("fill progress has a single writer shared by resume and by a graded guess", () => {
  assert.match(html, /function renderStatus\(\)\{[\s\S]*\$\("playFill"\)[\s\S]*\n\}/);
  const renderPlay = html.match(/function renderPlay\(\)\{[\s\S]*?\n\}/)[0];
  const applyGuess = html.match(/function applyGuessToBoard\(r\)\{[\s\S]*?\n\}/)[0];
  assert.match(renderPlay, /renderStatus\(\)/);
  assert.match(applyGuess, /renderStatus\(\)/);
});

test("the feed keeps the newest two graded lines and drops the third", () => {
  const one = feedPush([], "a");
  assert.deepEqual(one, ["a"]);
  const two = feedPush(one, "b");
  assert.deepEqual(two, ["b", "a"], "newest on top");
  const three = feedPush(two, "c");
  assert.deepEqual(three, ["c", "b"], "the oldest line drops");
  assert.deepEqual(feedPush(three, "d"), ["d", "c"]);
  // Depth holds no matter how long the run goes.
  let lines = [];
  for (const g of ["1", "2", "3", "4", "5", "6"]) lines = feedPush(lines, g);
  assert.deepEqual(lines, ["6", "5"]);
});

test("an empty line wipes the memory, so a fresh or restarted board inherits nothing", () => {
  assert.deepEqual(feedPush(["b", "a"], ""), []);
  assert.deepEqual(feedPush(["b", "a"], null), []);
  // Both board resets clear before they write.
  assert.match(html, /buildBoard\(\); renderPlay\(\); show\("play"\);\s*\n\s*feed\(""\);/);
  assert.match(html, /feed\(""\);   \/\/ the cleared board must not keep the old board's verdicts\s*\n\s*feed\(`<span class="d">↻ Challenge restarted\./);
});

test("the older line renders visibly faded beneath the newer one", () => {
  assert.match(html, /FEED\.map\(line=>`<div class="feedline">\$\{line\}<\/div>`\)\.join\(""\)/);
  assert.match(html, /\.feed \.feedline \+ \.feedline\{[^}]*opacity:\.45/);
});

test("feedback copy still comes from the existing explanations — presentation only", () => {
  // Roster feedback text is the server's explanation with the same fallback.
  assert.match(html, /const context=esc\(f\.explanation\|\|fallback\)/);
  assert.match(html, /feed\(good\s*\n?\s*\? `<span class="c">✔ \$\{context\}<\/span>/);
  // The span's class is the miss tone (#18); the string inside it is untouched.
  assert.match(html, />✕ \$\{clause\} · strike \$\{r\.strikes\}\/\$\{ST\.strike_limit\}<\/span>`/);
  // Top 8 near-miss context is untouched.
  assert.match(html, /ctx=` · \$\{val\} \$\{gi\.unit\}, #\$\{gi\.rank\} all-time`/);
});

test("Back, restart and Enter survive the relayout", () => {
  assert.match(play, /id="playBack">← Back</);
  assert.match(play, /id="playRestart"[^>]*aria-label="Restart Challenge"/);
  assert.match(play, /id="guessBtn"[^>]*>Enter</);
  assert.match(html, /\$\("playBack"\)\.onclick=leaveChallenge/);
  assert.match(html, /\$\("playRestart"\)\.onclick=restartChallenge/);
});
