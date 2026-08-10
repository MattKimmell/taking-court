export const HOUSE_TAKE_ROTATION = [
  {
    title: "Opening night arguments",
    items: [
      {
        id: "franchise-cornerstone",
        type: "rank",
        prompt: "Rank the franchise cornerstones you would trust for the next five years.",
        options: [
          { key: "jokic", label: "Nikola Jokic" },
          { key: "giannis", label: "Giannis Antetokounmpo" },
          { key: "luka", label: "Luka Doncic" },
          { key: "shai", label: "Shai Gilgeous-Alexander" },
        ],
      },
      {
        id: "playoff-problem",
        type: "multiple_choice",
        prompt: "Who is the worst playoff matchup when everything tightens up?",
        options: [
          { key: "denver", label: "Denver" },
          { key: "oklahoma-city", label: "Oklahoma City" },
          { key: "boston", label: "Boston" },
          { key: "minnesota", label: "Minnesota" },
        ],
      },
      {
        id: "one-shot",
        type: "multiple_choice",
        prompt: "One shot to save the season. Who gets it?",
        options: [
          { key: "curry", label: "Stephen Curry" },
          { key: "durant", label: "Kevin Durant" },
          { key: "brunson", label: "Jalen Brunson" },
          { key: "lillard", label: "Damian Lillard" },
        ],
      },
    ],
  },
  {
    title: "Legacy court",
    items: [
      {
        id: "aughts-first-pick",
        type: "rank",
        prompt: "Rank the 2000s stars you would draft first for one prime season.",
        options: [
          { key: "kobe", label: "Kobe Bryant" },
          { key: "duncan", label: "Tim Duncan" },
          { key: "shaq", label: "Shaquille O'Neal" },
          { key: "kg", label: "Kevin Garnett" },
        ],
      },
      {
        id: "pure-bucket",
        type: "multiple_choice",
        prompt: "Who is the purest tough-shot bucket?",
        options: [
          { key: "kobe", label: "Kobe Bryant" },
          { key: "durant", label: "Kevin Durant" },
          { key: "melo", label: "Carmelo Anthony" },
          { key: "tmac", label: "Tracy McGrady" },
        ],
      },
      {
        id: "defense-anchor",
        type: "multiple_choice",
        prompt: "Who anchors your defense in a seven-game series?",
        options: [
          { key: "duncan", label: "Tim Duncan" },
          { key: "garnett", label: "Kevin Garnett" },
          { key: "hakeem", label: "Hakeem Olajuwon" },
          { key: "dwight", label: "Dwight Howard" },
        ],
      },
    ],
  },
  {
    title: "Barbershop ballot",
    items: [
      {
        id: "must-watch",
        type: "rank",
        prompt: "Rank these players by who makes you stop scrolling first.",
        options: [
          { key: "ja", label: "Ja Morant" },
          { key: "anthony-edwards", label: "Anthony Edwards" },
          { key: "wembanyama", label: "Victor Wembanyama" },
          { key: "zion", label: "Zion Williamson" },
        ],
      },
      {
        id: "build-around",
        type: "multiple_choice",
        prompt: "Which young star would you build around today?",
        options: [
          { key: "wembanyama", label: "Victor Wembanyama" },
          { key: "anthony-edwards", label: "Anthony Edwards" },
          { key: "paolo", label: "Paolo Banchero" },
          { key: "haliburton", label: "Tyrese Haliburton" },
        ],
      },
      {
        id: "most-pressure",
        type: "multiple_choice",
        prompt: "Who is under the most pressure next postseason?",
        options: [
          { key: "embiid", label: "Joel Embiid" },
          { key: "booker", label: "Devin Booker" },
          { key: "tatum", label: "Jayson Tatum" },
          { key: "lebron", label: "LeBron James" },
        ],
      },
    ],
  },
];

export const TEAM_NAMES = {
  ATL: "Hawks",
  BOS: "Celtics",
  BRK: "Nets",
  CHO: "Hornets",
  CHI: "Bulls",
  CLE: "Cavaliers",
  DAL: "Mavericks",
  DEN: "Nuggets",
  DET: "Pistons",
  GSW: "Warriors",
  HOU: "Rockets",
  IND: "Pacers",
  LAC: "Clippers",
  LAL: "Lakers",
  MEM: "Grizzlies",
  MIA: "Heat",
  MIL: "Bucks",
  MIN: "Timberwolves",
  NOP: "Pelicans",
  NYK: "Knicks",
  OKC: "Thunder",
  ORL: "Magic",
  PHI: "76ers",
  PHO: "Suns",
  POR: "Trail Blazers",
  SAC: "Kings",
  SAS: "Spurs",
  TOR: "Raptors",
  UTA: "Jazz",
  WAS: "Wizards",
};

export const HOUSE_CHALLENGE_ROTATION = [
  { axis: "team", value: "LAL", position: "G", target: 5 },
  { axis: "college", value: "Duke", position: "F", target: 4 },
  { axis: "team", value: "CHI", position: "C", target: 3 },
  { axis: "college", value: "UNC", position: "G", target: 4 },
  { axis: "team", value: "BOS", position: "F", target: 5 },
  { axis: "college", value: "Kentucky", position: "G", target: 5 },
];

const POSITION_NOUN = { G: "guards", F: "forwards", C: "centers" };

export function courtDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function courtToken(date) {
  return `court_${date}`;
}

export function dayIndexFor(date) {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86400000);
}

export function houseTakeForDate(date) {
  const dayIndex = dayIndexFor(date);
  const take = HOUSE_TAKE_ROTATION[((dayIndex % HOUSE_TAKE_ROTATION.length) + HOUSE_TAKE_ROTATION.length) % HOUSE_TAKE_ROTATION.length];
  return {
    id: `house_take_${date}`,
    title: take.title,
    items: take.items.map((item) => ({
      ...item,
      options: item.options.map((option) => ({ ...option })),
    })),
  };
}

export function challengePrompt(challenge) {
  const noun = POSITION_NOUN[challenge.position];
  if (challenge.axis === "team") {
    return `Name ${challenge.target} ${noun} who played for the ${TEAM_NAMES[challenge.value] ?? challenge.value}.`;
  }
  return `Name ${challenge.target} ${noun} who went to ${challenge.value}.`;
}

export function validateDailyChallenge(challenge) {
  if (!challenge || typeof challenge !== "object") return "invalid_challenge";
  if (challenge.axis !== "team" && challenge.axis !== "college") return "invalid_challenge_axis";
  if (!["G", "F", "C"].includes(challenge.position)) return "invalid_challenge_position";
  if (!Number.isInteger(challenge.target) || challenge.target < 3 || challenge.target > 8) return "invalid_challenge_target";
  if (challenge.axis === "team" && !Object.prototype.hasOwnProperty.call(TEAM_NAMES, challenge.value)) return "invalid_challenge_team";
  if (challenge.axis === "college" && !/^[A-Za-z0-9 .'()&-]{2,40}$/.test(String(challenge.value ?? ""))) return "invalid_challenge_college";
  return null;
}

export function dailyChallengeForDate(date) {
  const dayIndex = dayIndexFor(date);
  const base = HOUSE_CHALLENGE_ROTATION[((dayIndex % HOUSE_CHALLENGE_ROTATION.length) + HOUSE_CHALLENGE_ROTATION.length) % HOUSE_CHALLENGE_ROTATION.length];
  const challenge = { ...base };
  return {
    ...challenge,
    id: `house_challenge_${date}`,
    prompt: challengePrompt(challenge),
    filters: {
      mode: "roster",
      position: challenge.position,
      target: challenge.target,
      ...(challenge.axis === "team" ? { team: challenge.value } : { college: challenge.value }),
    },
  };
}

export function takeCourtBeats({ takeDone, challengeDone }) {
  return {
    take: !!takeDone,
    challenge: !!challengeDone,
    full_stack: !!takeDone && !!challengeDone,
  };
}

export function validateTakeItems(items) {
  if (!Array.isArray(items) || items.length !== 3) return "take_must_have_three_items";
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== "object") return "invalid_take_item";
    if (!/^[a-z0-9_-]{1,64}$/.test(String(item.id ?? ""))) return "invalid_take_item_id";
    if (ids.has(item.id)) return "duplicate_take_item_id";
    ids.add(item.id);
    if (item.type !== "rank" && item.type !== "multiple_choice") return "invalid_take_item_type";
    if (!String(item.prompt ?? "").trim()) return "take_prompt_required";
    if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 8) return "invalid_take_options";
    const optionKeys = new Set();
    for (const option of item.options) {
      if (!/^[a-z0-9_-]{1,64}$/.test(String(option?.key ?? ""))) return "invalid_take_option_key";
      if (optionKeys.has(option.key)) return "duplicate_take_option_key";
      optionKeys.add(option.key);
      if (!String(option.label ?? "").trim()) return "take_option_label_required";
    }
  }
  return null;
}

export function normalizeTakeAnswers(items, answers) {
  const structuralError = validateTakeItems(items);
  if (structuralError) return { error: structuralError, answers: null };
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return { error: "answers_required", answers: null };
  }
  const out = {};
  for (const item of items) {
    const optionKeys = item.options.map((option) => option.key);
    const valid = new Set(optionKeys);
    const raw = answers[item.id];
    if (item.type === "multiple_choice") {
      if (typeof raw !== "string" || !valid.has(raw)) return { error: "invalid_answer", answers: null };
      out[item.id] = raw;
    } else {
      if (!Array.isArray(raw) || raw.length !== optionKeys.length) return { error: "invalid_rank_answer", answers: null };
      const seen = new Set(raw);
      if (seen.size !== raw.length || raw.some((key) => !valid.has(key))) {
        return { error: "invalid_rank_answer", answers: null };
      }
      out[item.id] = raw.slice();
    }
  }
  return { error: null, answers: out };
}

export function takeConsensus(items, answerRows) {
  const rows = Array.isArray(answerRows) ? answerRows : [];
  return items.map((item) => {
    const optionLabels = new Map(item.options.map((option) => [option.key, option.label]));
    if (item.type === "multiple_choice") {
      const counts = {};
      for (const option of item.options) counts[option.key] = 0;
      for (const row of rows) {
        const key = row?.answers?.[item.id];
        if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key]++;
      }
      const ordered = Object.entries(counts)
        .map(([key, count]) => ({ key, label: optionLabels.get(key), count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      return { item_id: item.id, type: item.type, prompt: item.prompt, total: rows.length, choices: ordered };
    }

    const totals = {};
    const counts = {};
    for (const option of item.options) {
      totals[option.key] = 0;
      counts[option.key] = 0;
    }
    for (const row of rows) {
      const ranked = row?.answers?.[item.id];
      if (!Array.isArray(ranked)) continue;
      ranked.forEach((key, index) => {
        if (Object.prototype.hasOwnProperty.call(totals, key)) {
          totals[key] += index + 1;
          counts[key]++;
        }
      });
    }
    const ranking = item.options
      .map((option) => ({
        key: option.key,
        label: option.label,
        avg_rank: counts[option.key] ? Math.round((totals[option.key] / counts[option.key]) * 100) / 100 : null,
        count: counts[option.key],
      }))
      .sort((a, b) => (a.avg_rank ?? 99) - (b.avg_rank ?? 99) || a.label.localeCompare(b.label));
    return { item_id: item.id, type: item.type, prompt: item.prompt, total: rows.length, ranking };
  });
}
