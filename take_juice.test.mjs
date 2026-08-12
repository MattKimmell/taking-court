import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const court = readFileSync(new URL("./supabase/functions/mp/court.ts", import.meta.url), "utf8");

function fn(name) {
  const source = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(source, `${name} not found in index.html`);
  return source[0];
}

test("a picked answer is visibly picked and the alternatives stand down", () => {
  const paint = fn("paintTakeChoice");
  assert.match(paint, /row\.classList\.toggle\("chosen", chosen\)/);
  assert.match(paint, /row\.classList\.toggle\("dim", !!key && !chosen\)/);
  assert.match(html, /\.take-choice\.chosen\{border-color:var\(--accent\)/);
  assert.match(html, /\.take-choice\.dim\{opacity:\.55\}/);
  // Painted, not re-rendered — re-rendering the panel would drop focus mid-tap.
  assert.match(html, /COURT\.answers\[item\.id\]=el\.value;\s*\n\s*paintTakeChoice\(el\.value\);\s*\n\s*setLockReady\(true\)/);
  assert.match(html, /<label class="slot take-choice" data-key="\$\{esc\(o\.key\)\}"/);
  // Reopening the question paints the stored answer, not a blank slate.
  const render = fn("renderCourtTake");
  assert.match(render, /paintTakeChoice\(answer\);\s*\n\s*setLockReady\(!!answer\)/);
});

test("rank emphasises the position the room is compared on, and flashes the name that moved", () => {
  assert.match(html, /class="slot take-rank\$\{pos===0\?" top":""\}\$\{key===COURT\.takeMoved\?" moved":""\}"/);
  assert.match(html, /COURT\.takeMoved=arr\[next\];   \/\/ follow the name, not the row it left/);
  assert.match(html, /COURT\.takeMoved=null;   \/\/ the flash is for the move that just happened, once/);
  assert.match(html, /\.take-rank\.top\{border-color:var\(--accent\)/);
  assert.match(html, /@keyframes rankMoved\{/);
});

test("Lock announces readiness once, on the transition", () => {
  const ready = fn("setLockReady");
  assert.match(ready, /const was=!btn\.disabled/);
  assert.match(ready, /btn\.disabled=!ready/);
  assert.match(ready, /if\(ready && !was && !reduceMotion\(\)\)/);
  assert.match(ready, /if\(!ready\) btn\.classList\.remove\("ready"\)/);
  assert.match(html, /\.daily-primary\.ready\{animation:lockReady/);
  // Nothing re-enables the button behind setLockReady's back.
  assert.doesNotMatch(html, /\$\("courtTakeLock"\)\.disabled=false/);
});

test("Lock settles before the feedback arrives", () => {
  assert.match(html, /lock\.disabled=true; lock\.classList\.remove\("ready"\); lock\.classList\.add\("committing"\); lock\.textContent="Locking…"/);
  assert.match(html, /lock\.classList\.remove\("committing"\); lock\.textContent="Lock Answer"/);
  assert.match(html, /\.daily-primary\.committing\{opacity:\.75;transform:scale\(\.985\)\}/);
  // A failed lock hands the button back.
  assert.match(html, /if\(!r\.ok\)\{ lock\.disabled=false; \$\("courtTakeErr"\)\.textContent="Error: "\+r\.error; return; \}/);
});

test("the feedback kicker reads Locked In", () => {
  assert.match(html, /<div class="feedback-kicker">Locked In<\/div>/);
  assert.doesNotMatch(html, /Your answer is locked/i);
  assert.doesNotMatch(html, /YOUR ANSWER IS LOCKED/);
  // and it crossfades in rather than cutting.
  assert.match(html, /body\.classList\.remove\("settle-in"\); void body\.offsetWidth; body\.classList\.add\("settle-in"\)/);
  assert.match(html, /@keyframes settleIn\{from\{opacity:0;transform:translateY\(8px\)\}/);
});

test("distribution bars grow to their percentages instead of arriving formed", () => {
  // Born empty in CSS, told their width after paint.
  assert.match(html, /\.distribution-bar span\{display:block;height:100%;width:0;[\s\S]*transition:width \.52s/);
  assert.match(html, /<span data-pct="\$\{Math\.max\(0,Math\.min\(100,c\.pct\|\|0\)\)\}" style="transition-delay:\$\{i\*70\}ms">/);
  const grow = fn("growDistributionBars");
  assert.match(grow, /requestAnimationFrame\(\(\)=>requestAnimationFrame\(\(\)=>\{/);
  assert.match(grow, /bar\.style\.width=`\$\{Math\.max\(0,Math\.min\(100,Number\(bar\.dataset\.pct\)\|\|0\)\)\}%`/);
  assert.match(html, /growDistributionBars\(body\)/);
  // The rendered numbers are still the server's, unrounded by the animation.
  assert.match(html, /<strong>\$\{c\.pct\|\|0\}% · \$\{c\.count\} of \$\{total\}<\/strong>/);
});

test("a streak increase is held until Home is on screen, then spent there", () => {
  const render = fn("renderStreak");
  assert.match(html, /if\(srv\.current>prev\) STREAK_TICK=\{from:prev,to:srv\.current\}/);
  assert.match(render, /if\(!tick \|\| !homeVisible\(\) \|\| reduceMotion\(\) \|\| tick\.to!==to\)/);
  // Held (not dropped) while the player is still on the Take/Challenge screens.
  assert.match(render, /if\(tick && homeVisible\(\)\) STREAK_TICK=null;   \/\/ spent, even if not animated/);
  assert.match(render, /el\.classList\.remove\("streak-bump"\); void el\.offsetWidth; el\.classList\.add\("streak-bump"\)/);
  assert.match(html, /function homeVisible\(\)\{ return !\$\("lobby"\)\.classList\.contains\("hidden"\); \}/);
  assert.match(html, /#dailyStreak\.streak-bump\{animation:streakBump \.5s ease-out\}/);
  // Painted once, after the button has its fresh span.
  assert.match(html, /btn\.innerHTML = copy\.cta \+ ' <span id="dailyStreak"><\/span>';\s*\n[\s\S]{0,180}?if\(r\.streak\) setStreak\(r\.streak\); else renderStreak\(\);/);
});

test("reduced motion keeps every state change and drops only the travel", () => {
  const block = html.match(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\n  \}/)[0];
  for (const rule of [
    /\.take-rank\.moved\{animation:none\}/,
    /\.daily-primary\.ready\{animation:none\}/,
    /\.settle-in\{animation:none\}/,
    /#dailyStreak\.streak-bump\{animation:none\}/,
    /\.distribution-bar span\{transition:none\}/,
  ]) assert.match(block, rule);
  // The bars still get their real widths — the transition is what is dropped.
  assert.match(fn("growDistributionBars"), /bar\.style\.width=/);
  // The chosen/dim chrome is colour, not animation.
  assert.match(html, /\.take-choice\.chosen\{border-color/);
});

test("lock immutability and consensus math are untouched", () => {
  // The server still owns the lock plan and rejects a re-lock.
  assert.match(court, /takeItemLockPlan/);
  const contract = readFileSync(new URL("./supabase/functions/mp/court_contract.js", import.meta.url), "utf8");
  assert.match(contract, /export function takeItemLockPlan/);
  assert.match(contract, /: \{ error: "take_answer_locked" \};/);
  assert.match(contract, /if \(firstUnanswered !== itemIndex\) return \{ error: "take_item_out_of_order" \}/);
  // The client sends the same payload it always did.
  assert.match(html, /api\("court_take_item_lock",\{ day:COURT\.date, item_id:item\.id, answer, client_id:clientId\(\), label:ensureName\(\) \}\)/);
  // Percentages come from the server's consensus row, not from the renderer.
  assert.match(html, /const item=f\.item, row=f\.consensus\|\|\{\}, total=Number\(row\.total\)\|\|0/);
  assert.match(contract, /export function takeConsensus/);
});
