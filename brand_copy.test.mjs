import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Brand styling: no em or en dashes in anything a player reads. They are the
// most recognisable tell of machine-written copy, and every one of them was a
// comma, a colon, a full stop or the app's own " · " separator wearing a
// costume. Code comments are exempt because nobody plays them.
const DASHES = /[—–]/;

function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) return "";
      // A trailing comment too, but only where "//" follows whitespace and not
      // a colon, so "https://" survives.
      return line.replace(/(?<![:\/])\s\/\/.*$/, "");
    })
    .join("\n");
}

const surfaces = [
  "index.html",
  ...readdirSync("supabase/functions/mp")
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".test.mjs"))
    .map((f) => `supabase/functions/mp/${f}`),
];

test("no em dashes reach the player", () => {
  const offenders = [];
  for (const file of surfaces) {
    stripComments(readFileSync(file, "utf8")).split("\n").forEach((line, i) => {
      if (DASHES.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, [], `em dashes in player-facing copy:\n${offenders.join("\n")}`);
});

test("the separator the app actually uses is the middle dot", () => {
  const html = readFileSync("index.html", "utf8");
  // Not a style preference: · is already the separator in the share signature,
  // the status row, the distribution stats and the strike line, so a dash in
  // the same slot reads as a different kind of thing.
  for (const sep of [
    /Taking Court · \$\{day\}|COURT_SHARE_BRAND\} · \$\{day\}/,
    /· strike \$\{r\.strikes\}\/\$\{ST\.strike_limit\}/,
    /% · \$\{Number\(c\.count\)/,
  ]) {
    const src = sep.source.includes("COURT_SHARE_BRAND")
      ? readFileSync("supabase/functions/mp/court_contract.js", "utf8")
      : html;
    assert.match(src, sep);
  }
});
