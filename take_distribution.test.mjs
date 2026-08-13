import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const contract = readFileSync(new URL("./supabase/functions/mp/court_contract.js", import.meta.url), "utf8");

// The shaping is the part worth running rather than pattern-matching, so it is
// pure and gets lifted out of the file and exercised for real.
function lift(name) {
  const source = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(source, `${name} not found in index.html`);
  return source[0];
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const api = new Function(
  `${lift("responseN")}\n${lift("takeDistribution")}\n${lift("takeSampleCopy")}\n${lift("takeMineSummary")}\n${lift("distributionHtml")}\nconst esc=arguments[0];\n` +
  `return { takeDistribution, takeSampleCopy, takeMineSummary, distributionHtml };`
)(esc);
const { takeDistribution, takeSampleCopy, takeMineSummary, distributionHtml } = api;

const pick = {
  item_id: "i1", type: "multiple_choice", prompt: "Best of the 2010s?", total: 8,
  choices: [
    { key: "lbj", label: "LeBron", count: 5, pct: 63 },
    { key: "kd", label: "Durant", count: 2, pct: 25 },
    { key: "steph", label: "Curry", count: 1, pct: 13 },
  ],
};
const rank = {
  item_id: "i2", type: "rank", prompt: "Rank the bigs", total: 4,
  ranking: [
    { key: "shaq", label: "Shaq", avg_rank: 1.5, count: 4, top_count: 3, top_pct: 75 },
    { key: "duncan", label: "Duncan", avg_rank: 2.1, count: 4, top_count: 1, top_pct: 25 },
    { key: "hakeem", label: "Hakeem", avg_rank: null, count: 0, top_count: 0, top_pct: 0 },
  ],
};

test("a pick and a rank shape into the same row list, so one renderer can serve both", () => {
  const a = takeDistribution(pick, "kd");
  const b = takeDistribution(rank, ["duncan", "shaq", "hakeem"]);
  for (const dist of [a, b]) {
    assert.equal(dist.total > 0, true);
    for (const row of dist.rows) {
      for (const field of ["key", "label", "pct", "count", "total", "stat", "mine"]) {
        assert.ok(field in row, `${field} missing from a ${dist.type} row`);
      }
    }
  }
  assert.deepEqual(a.rows.map((r) => r.pct), [63, 25, 13]);
  // A rank's bar is "ranked first" — the only rank number that is a share of
  // the room. avg_rank is a position and cannot be a bar width.
  assert.deepEqual(b.rows.map((r) => r.pct), [75, 25, 0]);
  assert.deepEqual(b.rows.map((r) => r.meta), ["avg rank 1.5", "avg rank 2.1", "No ranks yet"]);
  assert.deepEqual(b.rows.map((r) => r.pos), [1, 2, 3]);
  assert.equal(a.rows[0].pos, null, "a pick has no position");
});

test("the player's own answer is marked in both item types, and nowhere else", () => {
  const a = takeDistribution(pick, "kd");
  assert.deepEqual(a.rows.map((r) => r.mine), [false, true, false]);
  assert.equal(a.mine.label, "Durant");
  // A rank is owned by what you put FIRST, not by every name you ordered.
  const b = takeDistribution(rank, ["duncan", "shaq", "hakeem"]);
  assert.deepEqual(b.rows.map((r) => r.mine), [false, true, false]);
  assert.equal(b.mine.label, "Duncan");
  // No answer, no highlight — and no crash.
  for (const missing of [undefined, null, "", []]) {
    const d = takeDistribution(pick, missing);
    assert.equal(d.mine, null);
    assert.equal(d.rows.some((r) => r.mine), false);
  }
  assert.equal(takeDistribution(rank, []).mine, null);
  assert.equal(takeDistribution(null, "kd").rows.length, 0);
});

test("every percentage carries its sample size", () => {
  assert.deepEqual(takeDistribution(pick, "kd").rows.map((r) => r.stat),
    ["63% · 5 of 8", "25% · 2 of 8", "13% · 1 of 8"]);
  assert.deepEqual(takeDistribution(rank, ["shaq"]).rows.map((r) => r.stat),
    ["75% first · 3 of 4", "25% first · 1 of 4", "0% first · 0 of 4"]);
  const rendered = distributionHtml(takeDistribution(pick, "kd"));
  assert.match(rendered, /63% · 5 of 8/);
  assert.match(rendered, /<div class="distribution-row mine">[\s\S]*Durant/);
});

test("a small room says it is a small room", () => {
  assert.equal(takeSampleCopy(0), "No room responses yet.");
  assert.equal(takeSampleCopy(1), "1 response so far, check back later to see the average take.");
  for (const n of [1, 2, 3, 4]) assert.match(takeSampleCopy(n), /check back later to see the average take/);
  assert.equal(takeSampleCopy(4), "4 responses so far, check back later to see the average take.");
  // No em dashes anywhere in the room copy.
  for (const n of [0, 1, 2, 4, 9]) assert.doesNotMatch(takeSampleCopy(n), /[—–]/);
  // Past the early band it just states the size.
  assert.equal(takeSampleCopy(9), "9 responses in the room so far.");
  // Junk from a half-built response reads as an empty room, not as NaN.
  for (const junk of [null, undefined, NaN, -4, "x"]) assert.equal(takeSampleCopy(junk), "No room responses yet.");
  // An empty room has no percentage to state, so it states none rather than
  // printing "0% · 0 of 0" under copy that just said there are no responses.
  for (const row of [{ type: "multiple_choice", total: 0, choices: [{ key: "a", label: "A" }] },
                     { type: "rank", total: 0, ranking: [{ key: "a", label: "A", avg_rank: null }] }]) {
    assert.deepEqual(takeDistribution(row, null).rows.map((r) => r.stat), ["—"]);
  }
});

test("the player's own row is the only thing marking it as theirs", () => {
  // takeMineSummary still resolves the locked answer — the per-item feedback
  // title is built from it — but the day surface no longer restates it above
  // the list: that row already carries the accent border and the orange bar.
  assert.equal(takeMineSummary(takeDistribution(pick, "kd")), "Durant");
  assert.equal(takeMineSummary(takeDistribution(rank, ["duncan", "shaq"])), "Duncan first");
  assert.equal(takeMineSummary(takeDistribution(pick, "")), "");
  assert.equal(takeMineSummary(null), "");
  const block = html.match(/function takeBlockHtml\([\s\S]*?\n\}/)[0];
  assert.doesNotMatch(block, /you-chip/);
  assert.doesNotMatch(html, /class="you-chip"/);
  assert.equal(takeDistribution(pick, "kd").rows.filter((r) => r.mine).length, 1);
  assert.match(html, /\.distribution-row\.mine\{border-color:var\(--accent\)\}/);
  assert.match(html, /\.distribution-row\.mine \.distribution-bar span\{background:var\(--accent\)\}/);
});

test("the day surface renders each item with type, prompt and the shared distribution", () => {
  const block = html.match(/function takeBlockHtml\([\s\S]*?\n\}/)[0];
  assert.match(block, /const dist=takeDistribution\(row, mine\)/);
  assert.match(block, /<div class="tb-type">\$\{TAKE_TYPE_LABEL\[dist\.type\]\|\|"Pick"\}<\/div>/);
  assert.match(block, /<div class="tb-prompt">\$\{esc\(row\.prompt\|\|""\)\}<\/div>/);
  assert.match(block, /takeSampleCopy\(dist\.total\)/);
  assert.match(block, /\$\{distributionHtml\(dist\)\}/);
  assert.match(html, /const TAKE_TYPE_LABEL=\{ rank:"Rank", multiple_choice:"Pick" \}/);
  // Both surfaces call the one module; the day surface no longer hand-rolls rows.
  const consensus = html.match(/function renderCourtConsensus\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(consensus, /rows\.map\(row=>takeBlockHtml\(row, COURT\.answers\[row\.item_id\]\)\)/);
  assert.doesNotMatch(consensus, /class="slot"/, "the bare count list is gone");
  assert.doesNotMatch(consensus, /\$\{c\.count\}<\/div>/);
  // and the bars grow there too, from the same helper.
  assert.match(consensus, /growDistributionBars\(box\)/);
  // An empty room still says so rather than rendering nothing.
  assert.match(consensus, /: `<div class="note">No consensus yet\.<\/div>`/);
});

test("per-item feedback reads the same module it always rendered by hand", () => {
  const fb = html.match(/function renderCourtTakeFeedback\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(fb, /const dist=takeDistribution\(row, f\.answer\)/);
  assert.match(fb, /\$\{distributionHtml\(dist\)\}/);
  assert.match(fb, /\$\{esc\(takeSampleCopy\(total\)\)\}/);
  // The hero title still names the player's own answer against the room.
  assert.match(fb, /% also put \$\{mineLabel\} first · /);
  assert.match(fb, /% picked \$\{mineLabel\} too · /);
  assert.match(fb, /responseN\(total\)/);
  assert.match(fb, /<div class="feedback-kicker">Locked In<\/div>/);
  // The lock, the settle and the growth are unchanged (#16).
  assert.match(fb, /body\.classList\.add\("settle-in"\)/);
  assert.match(fb, /growDistributionBars\(body\)/);
});

test("no consensus math moved to the client", () => {
  // Counts, percentages and average ranks are all still computed server-side.
  assert.match(contract, /pct: total \? Math\.round\(\(count \* 100\) \/ total\) : 0/);
  assert.match(contract, /top_pct: total \? Math\.round\(\(topCounts\[option\.key\] \* 100\) \/ total\) : 0/);
  assert.match(contract, /avg_rank: counts\[option\.key\] \? Math\.round\(\(totals\[option\.key\] \/ counts\[option\.key\]\) \* 100\) \/ 100 : null/);
  const dist = lift("takeDistribution");
  for (const forbidden of [/Math\.round/, /\/ *total/, /\+\+/]) {
    assert.doesNotMatch(dist, forbidden, "the client must not recompute the room's numbers");
  }
  // It only clamps what it is about to use as a CSS width.
  assert.match(dist, /pct:Math\.max\(0,Math\.min\(100,Number\(r\.top_pct\)\|\|0\)\)/);
  // A percentage the server never sent renders as zero, not as NaN%.
  const odd = takeDistribution({ type: "multiple_choice", total: 3, choices: [{ key: "a", label: "A" }] }, "a");
  assert.equal(odd.rows[0].pct, 0);
  assert.equal(odd.rows[0].stat, "0% · 0 of 3");
});
