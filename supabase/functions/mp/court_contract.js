export const HOUSE_TAKE_ROTATION = [
  {
    title: "Opening night arguments",
    // One question for the share card (#14) — the invite, not the three prompts.
    share_question: "Who do you trust to build around for the next five years?",
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
    share_question: "Which 2000s star do you take for one prime season?",
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
    share_question: "Who makes you stop scrolling first?",
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

/** "2026-08-12" -> "2026-08-13", in UTC, which is the only clock a Court day
 *  has. Returns null on anything that is not a date, so a caller cannot build a
 *  tease for a day that does not exist. */
export function nextCourtDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return null;
  const t = new Date(`${date}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + 86400000).toISOString().slice(0, 10);
}

export function houseTakeForDate(date) {
  const dayIndex = dayIndexFor(date);
  const take = HOUSE_TAKE_ROTATION[((dayIndex % HOUSE_TAKE_ROTATION.length) + HOUSE_TAKE_ROTATION.length) % HOUSE_TAKE_ROTATION.length];
  return {
    id: `house_take_${date}`,
    title: take.title,
    // Snapshotted into mp_court_days with the rest of the take, so a day keeps the
    // share line it shipped with even if the rotation is re-authored later.
    ...(take.share_question ? { share_question: take.share_question } : {}),
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

/** One calendar day contributes to streak at most once when any beat is done. */
export function dayCountsForStreak(beats) {
  return !!(beats?.take || beats?.challenge);
}

/**
 * Where Play Now / Continue Court should land (client routing).
 * - resume_challenge: in-progress Court Challenge attempt
 * - challenge_ready: Take locked, Challenge not finished — consensus then start/resume
 * - take: still need the Take (including challenge-only days wanting full stack)
 * - consensus: review / share surface when Take is locked (and Challenge not mid-run)
 */
export function courtContinueRoute({ takeDone, challengeDone, attemptStatus }) {
  const take = !!takeDone;
  const challenge = !!challengeDone;
  const status = attemptStatus || null;
  if (status === "in_progress") return "resume_challenge";
  if (!take) return "take";
  if (challenge || status === "completed" || status === "eliminated" || status === "expired") {
    return "consensus";
  }
  return "challenge_ready";
}

/** Frozen house Challenge payload shape every player should share for a date. */
export function frozenChallengePublicFields(definition) {
  if (!definition || typeof definition !== "object") return null;
  return {
    id: definition.id ?? null,
    axis: definition.axis ?? null,
    value: definition.value ?? null,
    position: definition.position ?? null,
    target: definition.target ?? null,
    prompt: definition.prompt ?? null,
    filters: definition.filters ? { ...definition.filters } : null,
  };
}

/** Player Take lock response: compare payload first, then explicit lock + full topic. */
export function playerTakeLockOut(compareOut, topicOut) {
  return {
    ...(compareOut || {}),
    locked: true,
    topic: topicOut,
  };
}

/** Crew Take reveal: others' answers stay hidden until the viewer locked today's Take. */
export function crewCanRevealTakes(viewerTakeDone) {
  return !!viewerTakeDone;
}

export function crewMemberCourtFlags({ takeDone, challengeDone }) {
  const take_done = !!takeDone;
  const challenge_done = !!challengeDone;
  return {
    take_done,
    challenge_done,
    played_today: take_done || challenge_done,
  };
}

/**
 * Crew room must use the same Daily Court day identity as solo for that UTC date.
 * Compare share tokens (court_YYYY-MM-DD) and/or calendar day strings.
 */
export function crewDayMatchesSolo({ crewDate, soloDate, crewShareToken, soloShareToken }) {
  if (crewDate && soloDate && String(crewDate) !== String(soloDate)) return false;
  if (crewShareToken && soloShareToken && String(crewShareToken) !== String(soloShareToken)) return false;
  if (!crewDate && !soloDate && !crewShareToken && !soloShareToken) return false;
  return true;
}

/**
 * Hottest-take social needs lock-to-reveal open and at least two Take locks.
 * Challenge-only members count for streak/played_today but do not enter hottest-take.
 */
export function crewHottestTakeEligible({ revealTakes, takeLockCount }) {
  return !!revealTakes && Number(takeLockCount) >= 2;
}

/** Copy for Challenge-only edge when some members finished Challenge without Take. */
export function crewChallengeOnlySocialNote({ challengeOnlyCount, takeLockCount }) {
  const n = Number(challengeOnlyCount) || 0;
  if (n <= 0) return null;
  const locks = Number(takeLockCount) || 0;
  if (locks === 0) {
    return `${n} member${n === 1 ? "" : "s"} finished Challenge only. Hottest Take waits on locked Takes.`;
  }
  return `${n} Challenge-only today (streak counts; hottest Take uses locked Takes only).`;
}

/**
 * Divergence from crew modal Take answers. Higher = hotter take.
 * MC: 1 when off-modal, 0 when on-modal. Rank: mean |rank - modalRank| / (n-1).
 */
export function takeHotScore(items, answers, consensusRows) {
  if (!items?.length || !answers || !consensusRows?.length) return 0;
  let sum = 0;
  let n = 0;
  for (const item of items) {
    const row = consensusRows.find((c) => c.item_id === item.id);
    const mine = answers[item.id];
    if (!row) continue;
    if (item.type === "multiple_choice") {
      const modal = row.choices?.[0]?.key;
      if (!modal || typeof mine !== "string") continue;
      sum += mine === modal ? 0 : 1;
      n += 1;
    } else if (item.type === "rank" && Array.isArray(mine) && Array.isArray(row.ranking)) {
      const modalRank = new Map(row.ranking.map((r, i) => [r.key, i]));
      const denom = Math.max(1, mine.length - 1);
      let local = 0;
      let count = 0;
      mine.forEach((key, idx) => {
        if (!modalRank.has(key)) return;
        local += Math.abs(idx - modalRank.get(key)) / denom;
        count += 1;
      });
      if (count) {
        sum += local / count;
        n += 1;
      }
    }
  }
  return n ? sum / n : 0;
}

/** Exact wording, and it sits immediately above the link (#14). */
export const COURT_SHARE_CTA = "Enter the Court of Public Opinion";
export const COURT_SHARE_BRAND = "Taking Court";

const SHARE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-12" -> "Aug 12". Parsed by field, never by Date, so the share line
 *  cannot drift a day between a UTC server and a reader's timezone. */
export function courtShareDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  if (!m) return null;
  const month = SHARE_MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : null;
}

/** Pose an authored ask as a question without inventing words: an existing
 *  question is left alone, an imperative ("Name 5 guards …") becomes
 *  "Can you name 5 guards …?". Both share lines run through this, so the Take
 *  and the Challenge read in one voice. */
export function questionize(text) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (s.endsWith("?")) return s;
  const body = s.replace(/[.!\s]+$/, "");
  if (!body) return null;
  return `Can you ${body.charAt(0).toLowerCase()}${body.slice(1)}?`;
}

/** The Take previewed as ONE question — never the three prompts, never what the
 *  player locked. A day's take is snapshotted into mp_court_days at creation, so
 *  days built before share_question existed fall back to their first item. */
export function takeShareQuestion(take) {
  const authored = String(take?.share_question ?? "").trim();
  if (authored) return authored;
  const first = (take?.items ?? [])[0];
  return questionize(first?.prompt) ?? (take?.title ? String(take.title) : null);
}

/** The Challenge previewed as its ask. Built from the structured fields where
 *  they exist so the wording matches challengePrompt by construction; the stored
 *  prompt is the fallback for filter-built or older definitions. */
export function challengeShareAsk(challenge) {
  const noun = POSITION_NOUN[challenge?.position];
  const target = challenge?.target;
  if (noun && Number.isInteger(target)) {
    if (challenge.axis === "team") {
      return `Can you name ${target} ${noun} who played for the ${TEAM_NAMES[challenge.value] ?? challenge.value}?`;
    }
    if (challenge.axis === "college") return `Can you name ${target} ${noun} who went to ${challenge.value}?`;
  }
  return questionize(challenge?.prompt);
}

/**
 * Text-only Daily share card (#14): brand + date, streak, a question per beat
 * the player actually earned, then the CTA. The link is appended by the caller,
 * which is why the CTA is the last line here.
 *
 * It previews the QUESTIONS, never the answers — no locked choices, no named
 * players — so a recipient can be sent today's card and still play it cold.
 */
export function courtShareSummary({ date, take, challenge, beats, streak, challengeAttempt, consensusGate }) {
  const safeBeats = takeCourtBeats({
    takeDone: beats?.take,
    challengeDone: beats?.challenge,
  });
  if (!safeBeats.take && !safeBeats.challenge) return null;
  const kind = safeBeats.full_stack ? "full_stack" : (safeBeats.challenge ? "challenge_only" : "take_only");
  const title = kind === "full_stack"
    ? "Daily Court full stack"
    : (kind === "challenge_only" ? "Daily Court Challenge" : "Daily Court Take");
  const prompt = kind === "challenge_only"
    ? challenge?.prompt
    : take?.title;
  const challengeScore = safeBeats.challenge ? {
    correct_count: Number(challengeAttempt?.correct_count ?? 0),
    target: Number(challenge?.target ?? challengeAttempt?.answer_target ?? 0),
    strikes: Number(challengeAttempt?.strikes ?? 0),
    status: challengeAttempt?.status ?? "completed",
  } : null;
  // A mark is a claim about the board, so it needs the board filled — a beat that
  // ended any other way shows the ask alone rather than implying a clear sheet.
  const challengeCleared = !!challengeScore
    && challengeScore.status === "completed"
    && challengeScore.target > 0
    && challengeScore.correct_count >= challengeScore.target;
  const takeQuestion = safeBeats.take ? takeShareQuestion(take) : null;
  const challengeAsk = safeBeats.challenge ? challengeShareAsk(challenge) : null;
  const day = courtShareDate(date);
  const streakCount = Number(streak?.current ?? 0);
  // The invite leads, the questions follow, and the signature closes. A card
  // that opened on branding asked the reader to get past it before reaching
  // anything they could answer.
  const sig = [
    day ? `${COURT_SHARE_BRAND} · ${day}` : COURT_SHARE_BRAND,
    streakCount > 0 ? `🔥 ${streakCount}` : null,
  ].filter(Boolean).join(" · ");
  const body = [
    takeQuestion,
    challengeAsk ? `${challengeAsk}${challengeCleared ? " ✓" : ""}` : null,
  ].filter(Boolean);
  const blocks = [COURT_SHARE_CTA, body.join("\n"), sig].filter(Boolean);
  return {
    kind,
    title,
    prompt,
    date,
    beats: safeBeats,
    streak: streakCount,
    consensus_count: Number(consensusGate?.have ?? 0),
    challenge_score: challengeScore,
    take_question: takeQuestion,
    challenge_ask: challengeAsk,
    challenge_cleared: challengeCleared,
    cta: COURT_SHARE_CTA,
    // Recipients open Play Now via ?court=1 (client boot).
    path: date ? `?court=1&day=${encodeURIComponent(date)}` : "?court=1",
    text: blocks.join("\n\n"),
  };
}

const RARITY_RANK = { deep_cut: 4, rare: 3, uncommon: 2, common: 1 };

/**
 * The recap's Challenge stat (#20): which of the names you actually got was the
 * hardest to get. Read off filled_slots, which already carries the pool's own
 * rarity_tier and the at_ms the slot was filled — no new scarcity is invented
 * and no new data is stored.
 *
 * Rarity first, then the longest gap before it landed, so "hardest" means what
 * it says even on a board where every answer is Common: it is then the one that
 * took you longest to come to, which is a true statement about the board you
 * played. Under two fills there is nothing for a pick to be harder THAN, so it
 * returns null rather than crowning a lone answer.
 */
export function hardestCorrectPick(filledSlots) {
  const rows = Object.entries(filledSlots ?? {})
    .map(([slot, fill]) => ({
      slot: Number(slot),
      name: typeof fill?.name === "string" ? fill.name : null,
      rarity_tier: fill?.rarity_tier ?? null,
      at_ms: Number(fill?.at_ms),
    }))
    .filter((row) => row.name && Number.isFinite(row.slot));
  if (rows.length < 2) return null;
  const gaps = new Map();
  let prev = 0;
  for (const row of rows.slice().sort((a, b) => (a.at_ms || 0) - (b.at_ms || 0))) {
    const at = Number.isFinite(row.at_ms) ? row.at_ms : prev;
    gaps.set(row.slot, Math.max(0, at - prev));
    prev = at;
  }
  const best = rows.slice().sort((a, b) =>
    (RARITY_RANK[b.rarity_tier] ?? 0) - (RARITY_RANK[a.rarity_tier] ?? 0)
    || (gaps.get(b.slot) ?? 0) - (gaps.get(a.slot) ?? 0)
    || a.slot - b.slot)[0];
  return { name: best.name, slot: best.slot, rarity_tier: best.rarity_tier, took_ms: gaps.get(best.slot) ?? 0 };
}

/**
 * Tomorrow's tease (#20): "Hmm I wonder [X]?" built from the SUBJECT of
 * tomorrow's content and nothing else — never an option label, never a player
 * name, never the position or the target. Naming the subject is the invite;
 * naming the ask would be the board.
 *
 * Both content generators are pure functions of the date, so this needs no row
 * and does not materialise tomorrow's day early — which matters, because
 * getOrCreateCourtDay snapshots a day at first play and an early row would
 * freeze content nobody has played yet. The flip side: it reads the rotation as
 * it stands today, so re-authoring the rotation before tomorrow would leave a
 * tease pointing at content that never shipped.
 */
export function tomorrowTease(date) {
  const next = nextCourtDate(date);
  if (!next) return null;
  const challenge = dailyChallengeForDate(next);
  const take = houseTakeForDate(next);
  // Alternates by day index rather than at random: a recap can be reopened, and
  // a tease that changed on refresh would read as two different tomorrows.
  const useChallenge = Math.abs(dayIndexFor(next) % 2) === 0;
  const subject = challenge?.axis === "team"
    ? (TEAM_NAMES[challenge.value] ?? null)
    : (challenge?.axis === "college" ? String(challenge.value ?? "") || null : null);
  const challengeLine = subject
    ? (challenge.axis === "team"
      ? `Hmm I wonder how many ${subject} you can name?`
      : `Hmm I wonder who you remember from ${subject}?`)
    : null;
  const title = String(take?.title ?? "").trim();
  const takeLine = title ? `Hmm I wonder which way you go on tomorrow's ${title.toLowerCase()}?` : null;
  const line = (useChallenge ? challengeLine : takeLine) ?? challengeLine ?? takeLine;
  return line ? { date: next, line } : null;
}

/** Player Take is link-only until review approves public listing (Browse out of this slice). */
export function takeIsPubliclyListed({ visibility, review_status } = {}) {
  return visibility === "public" && review_status === "approved";
}

/** Default create visibility for player-authored Takes. */
export function playerTakeCreateDefaults() {
  return { visibility: "unlisted", review_status: "unsubmitted" };
}

/** Home chrome contract for Daily Court IA (#7) — product nouns, not peer mode cards. */
export const HOME_CHROME = {
  product: "Daily Court",
  primaryCta: "Play Now",
  beats: ["Take", "Challenge"],
  secondary: ["Pickup", "Crew"],
  quiet: ["Create Take", "Freeplay"],
  join: "Join with a link or token",
  freeplayLabels: {
    top8: "Top 8 / recall",
    tiers: "Tier boards",
    lists: "Custom lists",
  },
  // Peer mode picker (Name It / Tier Lists / Your Lists / Pickup as equals) is folded.
  peerModePicker: false,
};

export function homeHasPeerModePicker() {
  return HOME_CHROME.peerModePicker === true;
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

/** Validate one Daily Take answer without requiring the other two items. */
export function normalizeTakeItemAnswer(item, answer) {
  if (!item || typeof item !== "object") return { error: "take_item_not_found", answer: null };
  const optionKeys = (item.options ?? []).map((option) => option.key);
  const valid = new Set(optionKeys);
  if (item.type === "multiple_choice") {
    if (typeof answer !== "string" || !valid.has(answer)) return { error: "invalid_answer", answer: null };
    return { error: null, answer };
  }
  if (item.type !== "rank" || !Array.isArray(answer) || answer.length !== optionKeys.length) {
    return { error: "invalid_rank_answer", answer: null };
  }
  const seen = new Set(answer);
  if (seen.size !== answer.length || answer.some((key) => !valid.has(key))) {
    return { error: "invalid_rank_answer", answer: null };
  }
  return { error: null, answer: answer.slice() };
}

/** Canonical resume/completion state for an immutable set of per-item locks. */
export function takeProgress(items, answers, completedAt = null) {
  const saved = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
  const answered_item_ids = items
    .filter((item) => Object.prototype.hasOwnProperty.call(saved, item.id))
    .map((item) => item.id);
  const next = items.find((item) => !Object.prototype.hasOwnProperty.call(saved, item.id));
  return {
    answered_item_ids,
    next_item_id: next?.id ?? null,
    completed: !!completedAt && !next,
  };
}

/** Server decision for sequencing, immutable locks, and idempotent retries. */
export function takeItemLockPlan(items, savedAnswers, itemId, answer) {
  const saved = savedAnswers && typeof savedAnswers === "object" && !Array.isArray(savedAnswers) ? savedAnswers : {};
  const itemIndex = items.findIndex((item) => item.id === itemId);
  if (itemIndex < 0) return { error: "take_item_not_found" };
  const normalized = normalizeTakeItemAnswer(items[itemIndex], answer);
  if (normalized.error) return { error: normalized.error };
  if (Object.prototype.hasOwnProperty.call(saved, itemId)) {
    const same = JSON.stringify(saved[itemId]) === JSON.stringify(normalized.answer);
    return same
      ? { error: null, item_index: itemIndex, answer: normalized.answer, answers: { ...saved }, idempotent: true }
      : { error: "take_answer_locked" };
  }
  const firstUnanswered = items.findIndex((item) => !Object.prototype.hasOwnProperty.call(saved, item.id));
  if (firstUnanswered !== itemIndex) return { error: "take_item_out_of_order" };
  return {
    error: null,
    item_index: itemIndex,
    answer: normalized.answer,
    answers: { ...saved, [itemId]: normalized.answer },
    idempotent: false,
  };
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
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      const ordered = Object.entries(counts)
        .map(([key, count]) => ({ key, label: optionLabels.get(key), count, pct: total ? Math.round((count * 100) / total) : 0 }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      return { item_id: item.id, type: item.type, prompt: item.prompt, total, choices: ordered };
    }

    const totals = {};
    const counts = {};
    const topCounts = {};
    for (const option of item.options) {
      totals[option.key] = 0;
      counts[option.key] = 0;
      topCounts[option.key] = 0;
    }
    let total = 0;
    for (const row of rows) {
      const ranked = row?.answers?.[item.id];
      if (!Array.isArray(ranked)) continue;
      total++;
      ranked.forEach((key, index) => {
        if (Object.prototype.hasOwnProperty.call(totals, key)) {
          totals[key] += index + 1;
          counts[key]++;
          if (index === 0) topCounts[key]++;
        }
      });
    }
    const ranking = item.options
      .map((option) => ({
        key: option.key,
        label: option.label,
        avg_rank: counts[option.key] ? Math.round((totals[option.key] / counts[option.key]) * 100) / 100 : null,
        count: counts[option.key],
        top_count: topCounts[option.key],
        top_pct: total ? Math.round((topCounts[option.key] * 100) / total) : 0,
      }))
      .sort((a, b) => (a.avg_rank ?? 99) - (b.avg_rank ?? 99) || a.label.localeCompare(b.label));
    return { item_id: item.id, type: item.type, prompt: item.prompt, total, ranking };
  });
}
