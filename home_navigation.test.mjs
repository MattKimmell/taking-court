import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("./service-worker.js", import.meta.url), "utf8");

test("Home exposes the five-entry navigation shell without onboarding", () => {
  for (const id of ["dailyBtn", "gameModesBtn", "multiplayerBtn", "lbBtn", "mineBtn"])
    assert.match(html, new RegExp(`id=["']${id}["']`));

  for (const removed of ["welcome", "welcomePlay", "welcomeSkip", "modeTiers", "freeplayPanel"])
    assert.doesNotMatch(html, new RegExp(`id=["']${removed}["']`));

  assert.doesNotMatch(html, /tc_seen/);
  assert.match(html, /class="pill hidden" id="modePill"/);
});

test("Game Modes and Multiplayer contain the requested destinations", () => {
  assert.match(html, /id="gameModesHome"/);
  assert.match(html, />Challenges</);
  assert.match(html, />What's Your Take\?</);
  assert.match(html, /id="multiplayerHome"/);
  assert.match(html, /id="pickupBtn"/);
  assert.match(html, /id="crewBtn"/);
  assert.match(html, /id="joinToken"/);
  assert.match(html, /id="multiplayerErr"/);
});

test("navigation origins preserve the hub and legacy Tier contracts", () => {
  assert.match(html, /\$\("nameHomeBack"\)\.onclick = \(\)=>show\("gameModesHome"\)/);
  assert.match(html, /\$\("challengeBrowseBack"\)\.onclick = \(\)=>show\("nameHome"\)/);
  assert.match(html, /\$\("challengeCustomBack"\)\.onclick = \(\)=>show\("nameHome"\)/);
  assert.match(html, /\$\("listsHomeBack"\)\.onclick = \(\)=>show\("gameModesHome"\)/);
  assert.match(html, /show\("multiplayerHome"\)/);
  assert.match(html, /TIER_RETURN_SCREEN="mine"/);
  assert.match(html, /TIER_RETURN_SCREEN="lobby"/);
  assert.match(html, /showLinkError\("Error: "\+r\.error\)/);
});

test("UI release bumps the PWA cache", () => {
  assert.match(worker, /const CACHE = "tc-v32"/);
});
