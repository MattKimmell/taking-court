export const TEAM_NAMES = {
  ATL: "Hawks", BOS: "Celtics", BRK: "Nets", CHO: "Hornets", CHI: "Bulls", CLE: "Cavaliers",
  DAL: "Mavericks", DEN: "Nuggets", DET: "Pistons", GSW: "Warriors", HOU: "Rockets",
  IND: "Pacers", LAC: "Clippers", LAL: "Lakers", MEM: "Grizzlies", MIA: "Heat", MIL: "Bucks",
  MIN: "Timberwolves", NOP: "Pelicans", NYK: "Knicks", OKC: "Thunder", ORL: "Magic",
  PHI: "76ers", PHO: "Suns", POR: "Trail Blazers", SAC: "Kings", SAS: "Spurs", TOR: "Raptors",
  UTA: "Jazz", WAS: "Wizards", SEA: "Seattle SuperSonics", NJN: "New Jersey Nets",
  WSB: "Washington Bullets", CHH: "Charlotte Hornets", VAN: "Vancouver Grizzlies", BUF: "Buffalo Braves",
  KCK: "Kansas City Kings", SDC: "San Diego Clippers", NOJ: "New Orleans Jazz", NYA: "New York Nets",
  PHW: "Philadelphia Warriors", SFW: "San Francisco Warriors", SYR: "Syracuse Nationals",
};

const POSITION_CODES = { G: "G", Guard: "G", F: "F", Forward: "F", C: "C", Center: "C" };
const POSITION_NAMES = { G: "Guard", F: "Forward", C: "Center" };
const FACET_PRIORITY = ["award", "draft", "college", "conference", "team", "position", "decade"];

const AWARDS = {
  mvp: { field: "mvp_n", singular: "MVP", plural: "MVPs", article: "an" },
  dpoy: { field: "dpoy_n", singular: "Defensive Player of the Year", plural: "Defensive Player of the Year awards" },
  roy: { field: "roy_n", singular: "Rookie of the Year", plural: "Rookie of the Year awards" },
  smoy: { field: "smoy_n", singular: "Sixth Man of the Year", plural: "Sixth Man of the Year awards" },
  mip: { field: "mip_n", singular: "Most Improved Player", plural: "Most Improved Player awards" },
  allstar: { field: "allstar_n", singular: "All-Star selection", plural: "All-Star selections", article: "an" },
  allstar10: { field: "allstar_n", singular: "All-Star selection", plural: "All-Star selections", minimum: 10, article: "an" },
  allnba: { field: "allnba_n", singular: "All-NBA selection", plural: "All-NBA selections", article: "an" },
  alldef: { field: "alldef_n", singular: "All-Defense selection", plural: "All-Defense selections", article: "an" },
  ring: { field: "rings", singular: "NBA title", plural: "NBA titles" },
};

function positionCode(value) {
  return POSITION_CODES[String(value ?? "")] ?? String(value ?? "");
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function teamName(abbr) {
  return TEAM_NAMES[String(abbr ?? "")] ?? String(abbr ?? "recorded team");
}

export function teamFirstPlayedContext({ name, team, ranges }) {
  const firstSeason = number(ranges?.[0]?.from);
  return firstSeason != null
    ? `${name} first played for the ${team} in ${firstSeason - 1}.`
    : `${name} played for the ${team}.`;
}

function draftClause(context, includePick = false) {
  const draft = context?.draft;
  if (!draft || number(draft.year) == null) return "went undrafted";
  const pick = number(draft.pick);
  const picked = includePick && pick != null ? ` No. ${pick}` : "";
  return `was drafted${picked} by the ${teamName(draft.team)} in ${draft.year}`;
}

function careerYears(context) {
  const first = number(context?.first_season);
  const last = number(context?.last_season);
  if (first == null || last == null) return null;
  return { first: first - 1, last };
}

function awardCount(context, key) {
  if (key === "hof") return context?.hof ? 1 : 0;
  const award = AWARDS[key];
  return award ? (number(context?.[award.field]) ?? 0) : 0;
}

function matchesFacet(context, key, rawValue) {
  if (key === "team") return list(context.team_ranges).length > 0 || list(context.teams).includes(rawValue);
  if (key === "position") return list(context.positions).includes(positionCode(rawValue));
  if (key === "decade") return list(context.decades).map(Number).includes(Number(rawValue));
  if (key === "college") return list(context.colleges).includes(rawValue);
  if (key === "conference") return list(context.conferences).some((row) => row?.conference === rawValue);
  if (key === "award") {
    if (rawValue === "hof") return !!context.hof;
    const award = AWARDS[rawValue];
    const count = awardCount(context, rawValue);
    return award ? count >= (award.minimum ?? 1) : false;
  }
  if (key === "draft") {
    const pick = number(context?.draft?.pick);
    const round = number(context?.draft?.round);
    if (pick == null && round == null) return false;
    if (rawValue === "first") return pick === 1;
    if (rawValue === "top3") return pick != null && pick <= 3;
    if (rawValue === "lottery") return pick != null && pick <= 14;
    if (rawValue === "round1") return round === 1;
    if (rawValue === "round2") return round === 2;
  }
  return true;
}

function primaryFacet(filters) {
  return FACET_PRIORITY.find((key) => filters?.[key] != null && filters[key] !== "") ?? "roster";
}

function correctExplanation(name, context, filters, facet) {
  const value = filters[facet];
  if (facet === "team") return `Yes, ${teamFirstPlayedContext({ name, team: teamName(value), ranges: context.team_ranges })}`;
  if (facet === "college") return `Yes, ${name} ${draftClause(context)}.`;
  if (facet === "conference") {
    const school = list(context.conferences).find((row) => row?.conference === value)?.college;
    const schoolClause = school ? ` attended ${school}, which counts as ${value} here, and` : "";
    return `Yes, ${name}${schoolClause} ${draftClause(context)}.`;
  }
  if (facet === "position") {
    const positions = list(context.positions).map((p) => POSITION_NAMES[p] ?? p).join("/");
    return `Yes, ${name} is classified as ${positions}.`;
  }
  if (facet === "decade") {
    const years = careerYears(context);
    return years ? `Yes, ${name}’s NBA career ran from ${years.first} to ${years.last}.` : `Yes, ${name} was active in the ${value}s.`;
  }
  if (facet === "draft") return `Yes, ${name} ${draftClause(context, true)}.`;
  if (facet === "award") {
    if (value === "hof") return `Yes, ${name} is in the Basketball Hall of Fame.`;
    const award = AWARDS[value];
    const count = awardCount(context, value);
    return `Yes, ${name} earned ${count} ${count === 1 ? award.singular : award.plural}.`;
  }
  return `Yes, ${name} qualifies for this challenge.`;
}

function incorrectExplanation(name, context, filters, facet) {
  const value = filters[facet];
  if (facet === "team") return `${name} did not complete a full season with the ${teamName(value)}.`;
  if (facet === "college") {
    const colleges = list(context.colleges);
    return colleges.length ? `${name} attended ${colleges.join(" / ")}.` : `${name} did not attend college.`;
  }
  if (facet === "conference") {
    const schools = list(context.conferences);
    if (schools.length) return `${name} attended ${schools.map((row) => `${row.college} (${row.conference})`).join(" / ")}.`;
    const colleges = list(context.colleges);
    return colleges.length ? `${name} attended ${colleges.join(" / ")}.` : `${name} did not attend college.`;
  }
  if (facet === "position") {
    const actual = list(context.positions).map((p) => POSITION_NAMES[p] ?? p).join("/") || "another position";
    return `${name} is classified as ${actual}—not ${POSITION_NAMES[positionCode(value)] ?? value}.`;
  }
  if (facet === "decade") {
    const years = careerYears(context);
    return years
      ? `${name}’s NBA career ran from ${years.first} to ${years.last}, outside the ${value}s.`
      : `${name} was not active in the ${value}s.`;
  }
  if (facet === "draft") {
    const draft = context?.draft;
    if (!draft || number(draft.pick) == null) return `${name} went undrafted.`;
    const labels = { first: "first overall pick", top3: "top-3 pick", lottery: "lottery pick", round1: "first-round pick", round2: "second-round pick" };
    return `${name} was drafted No. ${draft.pick} in round ${draft.round} in ${draft.year}—not a ${labels[value] ?? value}.`;
  }
  if (facet === "award") {
    if (value === "hof") return `${name} is not in the Basketball Hall of Fame.`;
    const award = AWARDS[value];
    const count = awardCount(context, value);
    if (value === "allstar10") return `${name} earned ${count} All-Star selections—not 10 or more.`;
    return count === 0
      ? `${name} did not earn ${award.article ?? "a"} ${award.singular}.`
      : `${name} earned ${count} ${count === 1 ? award.singular : award.plural}, but does not meet this honor filter.`;
  }
  return `${name} does not meet this challenge’s filters.`;
}

export function rosterGuessFeedback(data, context, filters = {}) {
  if (data?.result !== "correct" && data?.result !== "strike") return undefined;
  const primary = primaryFacet(filters);
  if (!context?.known_player) {
    return {
      result: "incorrect",
      canonical_player: null,
      explanation: "We couldn’t match that name to the NBA player directory.",
      context_type: "unknown",
      details: { filters, failed_filter: "unknown" },
    };
  }

  const name = String(context.player_name ?? data.display_name ?? "That player");
  const failed = FACET_PRIORITY.find((key) => filters?.[key] != null && filters[key] !== "" && !matchesFacet(context, key, filters[key]));
  const correct = data.result === "correct";
  const facet = correct ? primary : (failed ?? primary);
  return {
    result: correct ? "correct" : "incorrect",
    canonical_player: {
      player_key: context.player_key ?? null,
      display_name: name,
      position: list(context.positions).map((p) => POSITION_NAMES[p] ?? p).join("/") || "Unclassified",
    },
    explanation: correct
      ? correctExplanation(name, context, filters, facet)
      : incorrectExplanation(name, context, filters, facet),
    context_type: facet,
    details: { filters, failed_filter: failed ?? null, draft: context.draft ?? null, team_ranges: context.team_ranges ?? [] },
  };
}
