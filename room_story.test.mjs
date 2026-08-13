import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

function lift(name) {
  const source = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(source, `${name} not found in index.html`);
  return source[0];
}
const api = new Function(
  `${lift("responseN")}\n${lift("takeDistribution")}\n${html.match(/const ROOM_READ_MIN=\d+;/)[0]}\n` +
  `${lift("takeAlignment")}\n${lift("roomStory")}\nreturn { takeDistribution, takeAlignment, roomStory, ROOM_READ_MIN };`
)();
const { takeDistribution, takeAlignment, roomStory, ROOM_READ_MIN } = api;

const pick = (total, mineKey, pcts) => takeDistribution({
  type: "multiple_choice", total,
  choices: pcts.map(([key, pct, count]) => ({ key, label: key.toUpperCase(), pct, count })),
}, mineKey);
const rank = (total, mineTop, rows) => takeDistribution({
  type: "rank", total,
  ranking: rows.map(([key, top_pct, top_count, avg_rank]) => ({ key, label: key.toUpperCase(), top_pct, top_count, avg_rank, count: total })),
}, [mineTop, "zzz"]);

test("a room too small to have an opinion is early, not aligned and not an outlier", () => {
  assert.equal(ROOM_READ_MIN, 3);
  for (const n of [0, 1, 2]) {
    assert.equal(takeAlignment(pick(n, "a", [["a", 100, n], ["b", 0, 0]])), "early", `total ${n}`);
  }
  assert.equal(takeAlignment(pick(3, "a", [["a", 100, 3], ["b", 0, 0]])), "with");
  // No locked answer of mine is nothing to read either.
  assert.equal(takeAlignment(pick(9, "", [["a", 90, 8], ["b", 10, 1]])), "early");
  assert.equal(takeAlignment(pick(9, "gone", [["a", 90, 8], ["b", 10, 1]])), "early");
  assert.equal(takeAlignment(null), "early");
  assert.equal(takeAlignment(takeDistribution({ type: "multiple_choice", total: 9, choices: [] }, "a")), "early");
});

test("aligned means the room's top answer, for a pick and for a rank alike", () => {
  assert.equal(takeAlignment(pick(8, "a", [["a", 63, 5], ["b", 25, 2], ["c", 13, 1]])), "with");
  assert.equal(takeAlignment(pick(8, "b", [["a", 63, 5], ["b", 25, 2], ["c", 13, 1]])), "against");
  assert.equal(takeAlignment(pick(8, "c", [["a", 63, 5], ["b", 25, 2], ["c", 13, 1]])), "against");
  // A rank's leader is the consensus order's first place, which the server sorts
  // to the head of the list — the same row the card shows first.
  assert.equal(takeAlignment(rank(4, "shaq", [["shaq", 75, 3, 1.3], ["duncan", 25, 1, 1.8]])), "with");
  assert.equal(takeAlignment(rank(4, "duncan", [["shaq", 75, 3, 1.3], ["duncan", 25, 1, 1.8]])), "against");
});

test("a tie is not an outlier", () => {
  // Two answers with the same share: whichever the sort put second, the same
  // number of people said it, so there is nobody to be an outlier from.
  assert.equal(takeAlignment(pick(6, "b", [["a", 50, 3], ["b", 50, 3]])), "with");
  assert.equal(takeAlignment(rank(4, "duncan", [["shaq", 50, 2, 1.5], ["duncan", 50, 2, 1.5]])), "with");
  // A near-tie is still a miss — the rule is the room's answer, not "close".
  assert.equal(takeAlignment(pick(100, "b", [["a", 51, 51], ["b", 49, 49]])), "against");
});

test("the story reads the day without overclaiming", () => {
  assert.equal(roomStory(["with", "with", "with"], 8), "You are with the room on all 3.");
  assert.equal(roomStory(["against", "against"], 8), "Outlier day: you are out on your own on all 2.");
  assert.equal(roomStory(["with", "against", "with"], 8), "You are with the room on 2 of 3.");
  // One read is one read; it does not get pluralised into a pattern.
  assert.equal(roomStory(["with"], 5), "You are with the room.");
  assert.equal(roomStory(["against"], 5), "You are out on your own.");
  // Never claims unanimity of the whole room.
  for (const states of [["with"], ["with", "with"], ["against", "with"]]) {
    const line = roomStory(states, 40);
    assert.doesNotMatch(line, /everyone/i);
    assert.doesNotMatch(line, /nobody else/i);
    assert.doesNotMatch(line, /\ball of\b/i);
  }
});

test("an unreadable room says so instead of guessing", () => {
  assert.match(roomStory(["early", "early", "early"], 1), /first in/);
  assert.match(roomStory(["early", "early"], 2), /Too early to read the room/);
  assert.equal(roomStory([], 9), "Nothing locked yet.");
  assert.equal(roomStory(null, 9), "Nothing locked yet.");
  // Partly readable: the verdict covers what can be read and counts the rest.
  assert.equal(roomStory(["with", "early"], 6), "You are with the room. 1 still too early to call.");
  assert.equal(roomStory(["with", "with", "early"], 6), "You are with the room on all 2. 1 still too early to call.");
  assert.equal(roomStory(["against", "with", "early", "early"], 6), "You are with the room on 1 of 2. 2 still too early to call.");
  // The count in the sentence is of readable items, never of all of them.
  assert.doesNotMatch(roomStory(["with", "early", "early"], 6), /of 3/);
});

test("one pip per item, carrying its state and its number", () => {
  const render = html.match(/function renderRoomStory\([\s\S]*?\n\}/)[0];
  assert.match(render, /const states=dists\.map\(takeAlignment\)/);
  assert.match(render, /class="pip is-\$\{states\[i\]\}" data-item="\$\{esc\(rows\[i\]\.item_id\)\}"/);
  assert.match(render, /aria-label="Take \$\{i\+1\}: \$\{PIP_LABEL\[states\[i\]\]\}"/);
  assert.match(html, /const PIP_LABEL=\{ with:"with the room", against:"out on your own", early:"too early to call" \}/);
  for (const state of ["with", "against", "early"]) assert.match(html, new RegExp(`\\.pip\\.is-${state}\\{`));
  // The room size the story is told against is the largest sample on the day,
  // not whichever item happens to be first.
  assert.match(render, /Math\.max\(\(COURT\.gate&&COURT\.gate\.have\)\|\|0, \.\.\.dists\.map\(d=>d\.total\), 0\)/);
  // Nothing to read, nothing to show.
  assert.match(render, /story\.classList\.toggle\("hidden", !dists\.length\)/);
});

test("a pip lands you on the card that states it in full", () => {
  const jump = html.match(/function jumpToTakeBlock\([\s\S]*?\n\}/)[0];
  assert.match(jump, /\.take-block\[data-item-id="\$\{CSS\.escape\(itemId\)\}"\]/);
  assert.match(jump, /el\.scrollIntoView\(\{behavior:reduceMotion\(\)\?"auto":"smooth", block:"center"\}\)/);
  assert.match(jump, /if\(!el\) return/);
  // One highlight at a time, and it clears itself.
  assert.match(jump, /querySelectorAll\("\.take-block\.flash"\)\)\.forEach\(b=>b\.classList\.remove\("flash"\)\)/);
  assert.match(jump, /takeFlashTimer=setTimeout\(\(\)=>el\.classList\.remove\("flash"\),1400\)/);
  assert.match(jump, /clearTimeout\(takeFlashTimer\)/);
  assert.match(html, /<div class="take-block" data-item-id="\$\{esc\(row\.item_id\|\|""\)\}">/);
  // The highlight is a border, so reduced motion keeps it and drops only the wash.
  assert.match(html, /\.take-block\.flash\{border-color:var\(--accent2\);animation:blockFlash/);
  const block = html.match(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\n  \}/)[0];
  assert.match(block, /\.take-block\.flash\{animation:none\}/);
});

test("the story sits above the cards and does not replace them", () => {
  const card = html.slice(html.indexOf('<div id="courtConsensus" class="card hidden">'), html.indexOf('<!-- ===================== PLAYER TAKE'));
  assert.match(card, /<div class="room-story" id="courtRoomStory">[\s\S]*<div class="rs-title">Today's room<\/div>/);
  assert.ok(card.indexOf('id="courtRoomPips"') < card.indexOf('id="courtConsensusRows"'), "the story precedes the cards");
  const consensus = html.match(/function renderCourtConsensus\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(consensus, /renderRoomStory\(rows\);/);
  assert.match(consensus, /rows\.map\(row=>takeBlockHtml\(row, COURT\.answers\[row\.item_id\]\)\)/);
  // The day-level note states the size only; the story owns the reading.
  assert.match(consensus, /\$\("courtConsensusNote"\)\.textContent=have \? `\$\{have\} \$\{have===1\?"player has":"players have"\} locked today\.` : ""/);
  assert.doesNotMatch(consensus, /You are early\. The room will fill in/);
});
