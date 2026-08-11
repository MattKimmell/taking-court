import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const games = readFileSync(new URL("./supabase/functions/mp/games.ts", import.meta.url), "utf8");

test("Challenges opens a three-choice entry screen", () => {
  assert.match(html, /id="challengeSurprise">Surprise Me ⚡</);
  assert.match(html, /id="challengeBrowseBtn">Browse</);
  assert.match(html, /id="challengeCustomBtn">Custom Games</);
  assert.match(html, /\$\("modeNameIt"\)\.onclick = openNameHome/);
  assert.match(html, /const MODE_PILL_SCREENS = new Set\(\["share","preview","play","results","partyHost","partyPlay","partyRecap"\]\)/);
});

test("Browse is a dedicated screen containing approved catalog items", () => {
  assert.match(html, /id="challengeBrowse" class="card hidden"/);
  assert.match(html, /function renderChallengeBrowse\(\)[\s\S]*NAME_CATALOG\?\.categories/);
  assert.match(html, /\$\("challengeBrowseBtn"\)\.onclick=openChallengeBrowse/);
  assert.match(games, /db\.from\("mp_challenge_catalog"\)[\s\S]*\.eq\("status", "approved"\)/);
});

test("Team Rosters browse team first, then All Players or a position group", () => {
  assert.match(html, /class="teamgrid" aria-label="Team rosters"/);
  assert.match(html, /function renderRosterTeamOptions\(section, category, team\)/);
  for (const label of ["All Players", "Guards", "Forwards", "Centers"])
    assert.match(html, new RegExp(`>${label}`));
  assert.match(html, /api\("challenge_build",\{mode:"roster",team,target:8\}\)/);
  assert.match(html, /data-id="\$\{it\.sheet_id\}" data-k="\$\{it\.kind\}"/);
});

test("Custom Games owns the existing filter builder and return path", () => {
  assert.match(html, /id="challengeCustom" class="card hidden"[\s\S]*id="fBuild"/);
  assert.match(html, /function openChallengeCustom\(\)[\s\S]*CHALLENGE_RETURN_SCREEN="challengeCustom"/);
  assert.match(html, /\$\("challengeCustomBack"\)\.onclick = \(\)=>show\("nameHome"\)/);
});

test("Surprise Me immediately chooses from approved catalog presets", () => {
  assert.match(html, /\$\("challengeSurprise"\)\.onclick = async \(\)=>[\s\S]*flatMap\(c=>c\.items\)[\s\S]*createChallenge\(p\.sheet_id, catKind\(p\.kind\), true\)/);
});
