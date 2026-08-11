import assert from "node:assert/strict";
import test from "node:test";
import { rosterGuessFeedback, teamFirstPlayedContext } from "./roster_feedback.js";

const grantHill = {
  known_player: true,
  player_key: "hillgr01",
  player_name: "Grant Hill",
  first_season: 1995,
  last_season: 2013,
  positions: ["F"],
  teams: ["DET", "ORL", "PHO", "LAC"],
  decades: [1990, 2000, 2010],
  colleges: ["Duke"],
  conferences: [{ college: "Duke", conference: "ACC" }],
  team_ranges: [{ from: 1995, to: 2000 }],
  allstar_n: 7,
  allnba_n: 5,
  alldef_n: 0,
  mvp_n: 0,
  dpoy_n: 0,
  roy_n: 1,
  smoy_n: 0,
  mip_n: 0,
  rings: 0,
  career_points: 17137,
  hof: true,
  draft: { year: 1994, pick: 3, round: 1, team: "DET" },
};

function feedback(result, filters, context = grantHill) {
  return rosterGuessFeedback({ result, display_name: context.player_name }, context, filters);
}

test("team context uses the earliest recorded team season", () => {
  assert.equal(teamFirstPlayedContext({
    name: "Kobe Bryant", team: "Lakers", ranges: [{ from: 1997, to: 2016 }],
  }), "Kobe Bryant first played for the Lakers in 1996.");
});

test("college feedback uses existing draft team and year", () => {
  assert.equal(
    feedback("correct", { college: "Duke" }).explanation,
    "Yes, Grant Hill was drafted by the Pistons in 1994.",
  );
  assert.equal(
    feedback("strike", { college: "UNC" }).explanation,
    "Grant Hill attended Duke.",
  );
});

test("every roster facet has correct and false copy", () => {
  const cases = [
    [{ team: "DET" }, { team: "BOS" }, /^Yes, .*first played for the Pistons/, /did not complete a full season with the Celtics/],
    [{ position: "F" }, { position: "G" }, /classified as Forward/, /not Guard/],
    [{ decade: 2000 }, { decade: 1970 }, /career ran from 1994 to 2013/, /outside the 1970s/],
    [{ award: "roy" }, { award: "mvp" }, /Rookie of the Year/, /did not earn an MVP/],
    [{ draft: "top3" }, { draft: "first" }, /drafted No\. 3 by the Pistons in 1994/, /not a first overall pick/],
    [{ college: "Duke" }, { college: "UNC" }, /^Yes, .*drafted by the Pistons/, /attended Duke/],
    [{ conference: "ACC" }, { conference: "Big Ten" }, /counts as ACC here/, /attended Duke \(ACC\)/],
  ];
  for (const [goodFilters, badFilters, goodPattern, badPattern] of cases) {
    assert.match(feedback("correct", goodFilters).explanation, goodPattern);
    assert.match(feedback("strike", badFilters).explanation, badPattern);
  }
});

test("compound challenges explain the first failed distinctive facet", () => {
  const result = feedback("strike", { team: "DET", position: "F", award: "mvp" });
  assert.equal(result.context_type, "award");
  assert.equal(result.details.failed_filter, "award");
});

test("unknown names never reveal another valid answer", () => {
  const result = feedback("strike", { college: "Duke" }, { known_player: false });
  assert.equal(result.context_type, "unknown");
  assert.equal(result.canonical_player, null);
  assert.doesNotMatch(result.explanation, /Grant Hill/);
});

test("approved undrafted and no-college special cases stay factual", () => {
  const ben = { ...grantHill, player_key: "wallabe01", player_name: "Ben Wallace", draft: null };
  assert.equal(feedback("correct", { college: "Virginia Union" }, ben).explanation, "Yes, Ben Wallace went undrafted.");
  const lebron = { ...grantHill, player_key: "jamesle01", player_name: "LeBron James", colleges: [], conferences: [] };
  assert.equal(feedback("strike", { college: "Duke" }, lebron).explanation, "LeBron James did not attend college.");
});

test("Pickup legacy point and title thresholds use factual totals", () => {
  assert.equal(
    feedback("strike", { min_points: 20000 }).explanation,
    "Grant Hill scored 17,137 career points—not 20,000 or more.",
  );
  const winner = { ...grantHill, player_name: "Stephen Curry", rings: 4 };
  assert.equal(
    feedback("correct", { min_rings: 3 }, winner).explanation,
    "Yes, Stephen Curry won 4 NBA titles.",
  );
});
