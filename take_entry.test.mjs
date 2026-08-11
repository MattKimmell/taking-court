import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const lists = readFileSync(new URL("./supabase/functions/mp/lists.ts", import.meta.url), "utf8");

test("What's Your Take opens the same three-choice entry pattern", () => {
  assert.match(html, /id="listSurprise">Surprise Me ⚡</);
  assert.match(html, /id="listBrowseBtn">Browse</);
  assert.match(html, /id="listCustomBtn">Custom Games</);
  assert.match(html, /\$\("listBrowseBtn"\)\.onclick=openListBrowseHome/);
  assert.match(html, /\$\("listCustomBtn"\)\.onclick=openListCustom/);
});

test("Take Browse contains every approved public topic grouped by entry type", () => {
  assert.match(html, /id="listBrowseHome" class="card hidden"/);
  assert.match(html, /function renderListBrowse\(\)[\s\S]*ENTRY_CATS\.map[\s\S]*LIST_BROWSE\.filter/);
  assert.match(lists, /db\.from\("mp_list_topics"\)[\s\S]*\.eq\("review_status", "approved"\)/);
});

test("Take Custom Games owns creation, shared-link entry, and saved lists", () => {
  assert.match(html, /id="listCustom" class="card hidden"[\s\S]*id="listCreateBtn"[\s\S]*id="listJoinBtn"[\s\S]*id="myLists"/);
  assert.match(html, /function openListCustom\(\)[\s\S]*loadMyLists\(\)/);
  assert.match(html, /LIST_RETURN_SCREEN="listCustom"/);
});

test("Take builders return to the entry that opened them", () => {
  assert.match(html, /function returnFromList\(\)[\s\S]*LIST_RETURN_SCREEN==="listCustom"[\s\S]*LIST_RETURN_SCREEN==="listBrowseHome"/);
  assert.match(html, /\$\("listBuildBack"\)\.onclick=async\(\)=>[\s\S]*returnFromList\(\)/);
  assert.match(html, /\$\("listCompareBack"\)\.onclick=returnFromList/);
});
