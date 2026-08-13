import { actionGuess, actionStart } from "./games.ts";
import { db, ok, err, json, authedUserId, ownerFilter, safeClientId, computeStreak, loadRosterPool, rosterReveal } from "./shared.ts";
import type { PoolEntry } from "./shared.ts";
import { courtDate, courtShareSummary, courtToken, dailyChallengeForDate, hardestCorrectPick, houseTakeForDate, normalizeTakeAnswers, takeConsensus, takeCourtBeats, takeItemLockPlan, takeProgress, tomorrowTease, validateDailyChallenge, validateTakeItems } from "./court_contract.js";

type CourtDay = {
  id: string;
  day: string;
  share_token: string;
  house_take: {
    id: string;
    title: string;
    items: unknown[];
  };
  challenge_definition: Record<string, any>;
};

function dayFromBody(body: any): string {
  const d = String(body.day ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : courtDate();
}

async function buildCourtChallenge(day: string) {
  const definition = dailyChallengeForDate(day);
  const structuralError = validateDailyChallenge(definition);
  if (structuralError) throw new Error(`invalid_daily_challenge: ${structuralError}`);

  const preview = await db.rpc("mp_challenge_preview", { f: definition.filters });
  if (preview.error) throw preview.error;
  const pv = preview.data as any;
  if (pv?.verdict === "impossible" || pv?.unknown_filter || Number(pv?.known ?? 0) < definition.target) {
    throw new Error("invalid_daily_challenge: unsafe_pool");
  }

  const built = await db.rpc("mp_build_filtered_roster", {
    f: definition.filters,
    p_prompt: definition.prompt,
    p_target: definition.target,
    p_difficulty: pv.difficulty === "easy" ? "normal" : "hard",
  });
  if (built.error) throw built.error;
  const rosterSheetId = built.data as string;
  const pool = await loadRosterPool(rosterSheetId);
  if (pool.length < definition.target) throw new Error("invalid_daily_challenge: incomplete_pool");

  const shareToken = `court_challenge_${day}`;
  const existing = await db.from("mp_challenges").select("*").eq("share_token", shareToken).maybeSingle();
  let challenge = existing.data;
  if (!challenge) {
    const expiresAt = new Date(new Date(`${day}T00:00:00Z`).getTime() + 3 * 86400000).toISOString();
    const inserted = await db.from("mp_challenges").insert({
      share_token: shareToken,
      kind: "roster",
      roster_sheet_id: rosterSheetId,
      sheet_id: null,
      mode: "competition",
      status: "open",
      prompt: definition.prompt,
      answer_target: definition.target,
      question_version: 1,
      answers_snapshot: pool,
      strike_limit: 3,
      rules: { court_daily: true, strike_limit: 3, answer_target: definition.target, mode: "competition", kind: "roster" },
      max_participants: null,
      require_auth: false,
      creator_label: "Daily Court",
      expires_at: expiresAt,
    }).select("*").single();
    if (inserted.data) challenge = inserted.data;
    else {
      const raced = await db.from("mp_challenges").select("*").eq("share_token", shareToken).maybeSingle();
      if (raced.data) challenge = raced.data;
      else if (inserted.error) throw inserted.error;
    }
  }
  if (!challenge) throw new Error("daily_challenge_unavailable");
  return {
    ...definition,
    challenge_id: challenge.id,
    share_token: challenge.share_token,
    roster_sheet_id: rosterSheetId,
    pool_size: pool.length,
  };
}

async function ensureCourtChallenge(courtDay: CourtDay): Promise<CourtDay> {
  if (courtDay.challenge_definition?.challenge_id) return courtDay;
  const challenge = await buildCourtChallenge(courtDay.day);
  const updated = await db.from("mp_court_days")
    .update({ challenge_definition: challenge, updated_at: new Date().toISOString() })
    .eq("id", courtDay.id)
    .select("*")
    .single();
  return (updated.data as CourtDay | null) ?? { ...courtDay, challenge_definition: challenge };
}

export async function getOrCreateCourtDay(day = courtDate()): Promise<CourtDay | null> {
  const token = courtToken(day);
  const existing = await db.from("mp_court_days").select("*").eq("day", day).maybeSingle();
  if (existing.data) return await ensureCourtChallenge(existing.data as CourtDay);

  const houseTake = houseTakeForDate(day);
  const structuralError = validateTakeItems(houseTake.items);
  if (structuralError) throw new Error(`invalid_house_take: ${structuralError}`);
  const challenge = await buildCourtChallenge(day);

  const row = {
    day,
    share_token: token,
    house_take: houseTake,
    challenge_definition: challenge,
    status: "published",
  };
  const created = await db.from("mp_court_days").insert(row).select("*").single();
  if (created.data) return created.data as CourtDay;

  // A concurrent first resolve can win the unique constraint race.
  const again = await db.from("mp_court_days").select("*").eq("day", day).maybeSingle();
  return again.data ? await ensureCourtChallenge(again.data as CourtDay) : null;
}

async function courtStreak(userId: string | null, clientId: string | null, today: string) {
  const empty = { current: 0, last_played: null as string | null, played_today: false };
  const filter = ownerFilter(userId, clientId);
  if (!filter) return empty;

  const { data: locks } = await db.from("mp_court_take_locks")
    .select("day_id")
    .not("completed_at", "is", null)
    .or(filter);
  const dayIds = [...new Set((locks ?? []).map((row: any) => row.day_id).filter(Boolean))];
  const dates = new Set<string>();
  if (dayIds.length) {
    const { data: days } = await db.from("mp_court_days")
      .select("id, day")
      .in("id", dayIds);
    for (const row of days ?? []) dates.add(String(row.day));
  }

  const challengeDates = await completedChallengeDates(userId, clientId);
  for (const date of challengeDates) dates.add(date);
  if (!dates.size) return empty;
  const sorted = [...dates].sort();
  return {
    current: computeStreak(dates, today),
    last_played: sorted[sorted.length - 1],
    played_today: dates.has(today),
  };
}

async function completedChallengeDates(userId: string | null, clientId: string | null) {
  if (!userId && !clientId) return new Set<string>();
  const { data: days } = await db.from("mp_court_days").select("day, challenge_definition");
  const byChallenge = new Map<string, string>();
  for (const day of days ?? []) {
    const id = (day.challenge_definition as any)?.challenge_id;
    if (id) byChallenge.set(id, String(day.day));
  }
  if (!byChallenge.size) return new Set<string>();
  const { data: attempts } = await db.from("mp_attempts")
    .select("challenge_id, player_client_id, player_user_id, status")
    .in("challenge_id", [...byChallenge.keys()])
    .eq("status", "completed");
  const dates = new Set<string>();
  for (const attempt of attempts ?? []) {
    const mine = (userId && attempt.player_user_id === userId) || (clientId && attempt.player_client_id === clientId);
    if (mine) dates.add(byChallenge.get(attempt.challenge_id)!);
  }
  return dates;
}

async function takeLocks(dayId: string) {
  const { data } = await db.from("mp_court_take_locks")
    .select("id, author_client_id, author_user_id, author_label, answers, completed_at, created_at, updated_at")
    .eq("day_id", dayId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

async function courtChallengeAttempt(courtDay: CourtDay, userId: string | null, clientId: string | null) {
  const challengeId = courtDay.challenge_definition?.challenge_id;
  if (!challengeId || (!userId && !clientId)) return null;
  const { data } = await db.from("mp_attempts")
    .select("id, attempt_token, status, started_at, finished_at, elapsed_ms, ranking_time_ms, correct_count, strikes, filled_slots, player_client_id, player_user_id")
    .eq("challenge_id", challengeId);
  return (data ?? []).find((a: any) => (userId && a.player_user_id === userId) || (clientId && a.player_client_id === clientId)) ?? null;
}

// The pool the Daily Challenge drew from, but only once the caller's own
// attempt is closed. A finished board routes to the recap now (#18), so the
// "players you could have named" list has to live there too — and it has to
// survive a reload, which the finishing guess response cannot do. Gated on the
// attempt, never on the day: an in-progress or unstarted player must not be
// able to read the answers out of a daily payload.
async function courtReveal(courtDay: CourtDay, attempt: any) {
  if (!attempt || attempt.status === "in_progress") return null;
  const challengeId = courtDay.challenge_definition?.challenge_id;
  if (!challengeId) return null;
  const { data } = await db.from("mp_challenges")
    .select("answers_snapshot")
    .eq("id", challengeId)
    .maybeSingle();
  const snapshot = data?.answers_snapshot;
  return Array.isArray(snapshot) ? rosterReveal(snapshot as PoolEntry[]) : null;
}

async function courtState(req: Request, body: any, courtDay: CourtDay) {
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  const locks = await takeLocks(courtDay.id);
  const mine = locks.find((l: any) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  const completedLocks = locks.filter((l: any) => !!l.completed_at);
  const takeDone = !!mine?.completed_at;
  const challengeAttempt = await courtChallengeAttempt(courtDay, userId, clientId);
  const challengeDone = challengeAttempt?.status === "completed";
  const beats = takeCourtBeats({ takeDone, challengeDone });
  const streak = await courtStreak(userId, clientId, courtDay.day);
  const gate = { have: completedLocks.length, honest_empty: completedLocks.length <= 1 };
  return {
    locks,
    mine,
    takeDone,
    challengeAttempt,
    challengeDone,
    beats,
    consensus_gate: gate,
    streak,
    share: courtShareSummary({
      date: courtDay.day,
      take: courtDay.house_take,
      challenge: courtDay.challenge_definition,
      beats,
      streak,
      challengeAttempt,
      consensusGate: gate,
    }),
  };
}

export async function actionCourtDaily(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  const day = dayFromBody(body);
  const courtDay = await getOrCreateCourtDay(day);
  if (!courtDay) return err("court_day_unavailable", 500);

  const state = await courtState(req, body, courtDay);
  const items = courtDay.house_take.items;
  const progress = takeProgress(items, state.mine?.answers ?? {}, state.mine?.completed_at ?? null);
  const answered = new Set(progress.answered_item_ids);
  return ok({
    date: courtDay.day,
    day: { id: courtDay.id, share_token: courtDay.share_token },
    challenge: courtDay.challenge_definition,
    take: courtDay.house_take,
    your_answers: state.mine?.answers ?? {},
    take_done: state.takeDone,
    take_progress: progress,
    challenge_done: state.challengeDone,
    done: state.beats.take || state.beats.challenge,
    beats: state.beats,
    share: state.share,
    challenge_attempt: state.challengeAttempt ? {
      id: state.challengeAttempt.id,
      status: state.challengeAttempt.status,
      started: !!state.challengeAttempt.started_at,
      correct_count: state.challengeAttempt.correct_count ?? 0,
      strikes: state.challengeAttempt.strikes ?? 0,
      filled_slots: state.challengeAttempt.filled_slots ?? {},
      elapsed_ms: state.challengeAttempt.elapsed_ms ?? null,
      ranking_time_ms: state.challengeAttempt.ranking_time_ms ?? null,
      // Read off the caller's own fills, so it carries no information they did
      // not already earn (#20).
      hardest_pick: hardestCorrectPick(state.challengeAttempt.filled_slots ?? {}),
    } : null,
    tomorrow: tomorrowTease(courtDay.day),
    revealed_answers: await courtReveal(courtDay, state.challengeAttempt),
    consensus: state.mine ? takeConsensus(items.filter((item: any) => answered.has(item.id)), state.locks as any[]) : null,
    consensus_gate: state.consensus_gate,
    streak: state.streak,
  });
}

export async function actionCourtTakeLock(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  if (!userId && !clientId) return err("identity_required", 400);

  const day = dayFromBody(body);
  const courtDay = await getOrCreateCourtDay(day);
  if (!courtDay) return err("court_day_unavailable", 500);
  const items = courtDay.house_take.items;
  const normalized = normalizeTakeAnswers(items, body.answers);
  if (normalized.error) return err(normalized.error, 400);

  const locks = await takeLocks(courtDay.id);
  const mine = locks.find((l: any) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  if (mine) {
    for (const [itemId, answer] of Object.entries(mine.answers ?? {})) {
      if (JSON.stringify((normalized.answers as any)[itemId]) !== JSON.stringify(answer)) {
        return err("take_answer_locked", 409);
      }
    }
  }
  const now = new Date().toISOString();
  const patch = {
    answers: normalized.answers,
    author_label: String(body.label ?? "Anonymous").slice(0, 40),
    completed_at: mine?.completed_at ?? now,
    updated_at: now,
    ...(userId ? { author_user_id: userId } : {}),
  };

  if (mine) {
    await db.from("mp_court_take_locks").update(patch).eq("id", mine.id);
  } else {
    const { error: insertErr } = await db.from("mp_court_take_locks").insert({
      day_id: courtDay.id,
      author_client_id: clientId,
      author_user_id: userId,
      author_label: String(body.label ?? "Anonymous").slice(0, 40),
      answers: normalized.answers,
      completed_at: now,
    });
    if (insertErr) {
      const raced = await takeLocks(courtDay.id);
      const racedMine = raced.find((l: any) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
      if (!racedMine) return err(insertErr.message, 500);
      await db.from("mp_court_take_locks").update(patch).eq("id", racedMine.id);
    }
  }

  const after = await takeLocks(courtDay.id);
  const state = await courtState(req, body, courtDay);
  return ok({
    locked: true,
    date: courtDay.day,
    day: { id: courtDay.id, share_token: courtDay.share_token },
    challenge: courtDay.challenge_definition,
    take: courtDay.house_take,
    your_answers: normalized.answers,
    done: true,
    beats: state.beats,
    share: state.share,
    consensus: takeConsensus(items, after as any[]),
    consensus_gate: { have: after.length, honest_empty: after.length <= 1 },
    streak: state.streak,
  });
}

export async function actionCourtTakeItemLock(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  if (!userId && !clientId) return err("identity_required", 400);

  const day = dayFromBody(body);
  const courtDay = await getOrCreateCourtDay(day);
  if (!courtDay) return err("court_day_unavailable", 500);
  const items = courtDay.house_take.items as any[];
  const itemId = String(body.item_id ?? "");
  const locks = await takeLocks(courtDay.id);
  let mine = locks.find((l: any) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  let plan = takeItemLockPlan(items, mine?.answers ?? {}, itemId, body.answer);
  if (plan.error) {
    const status = plan.error === "take_item_not_found" ? 404
      : (plan.error === "take_item_out_of_order" || plan.error === "take_answer_locked") ? 409
      : 400;
    return err(plan.error, status);
  }

  const now = new Date().toISOString();
  const willComplete = items.every((item) => Object.prototype.hasOwnProperty.call(plan.answers, item.id));
  if (!plan.idempotent) {
    if (mine) {
      const updated = await db.from("mp_court_take_locks")
        .update({
          answers: plan.answers,
          author_label: String(body.label ?? mine.author_label ?? "Anonymous").slice(0, 40),
          updated_at: now,
          ...(willComplete && !mine.completed_at ? { completed_at: now } : {}),
          ...(userId ? { author_user_id: userId } : {}),
        })
        .eq("id", mine.id)
        .eq("updated_at", mine.updated_at)
        .select("id")
        .maybeSingle();
      if (updated.error) return err(updated.error.message, 500);
      if (!updated.data) return err("take_progress_conflict", 409);
    } else {
      const inserted = await db.from("mp_court_take_locks").insert({
        day_id: courtDay.id,
        author_client_id: clientId,
        author_user_id: userId,
        author_label: String(body.label ?? "Anonymous").slice(0, 40),
        answers: plan.answers,
        completed_at: willComplete ? now : null,
      });
      if (inserted.error) {
        // A concurrent first item can win the unique owner constraint. Treat an
        // identical lock as idempotent; never overwrite its answer.
        const raced = await takeLocks(courtDay.id);
        mine = raced.find((l: any) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
        plan = takeItemLockPlan(items, mine?.answers ?? {}, itemId, body.answer);
        if (plan.error) return err(plan.error, 409);
        if (!plan.idempotent) return err("take_progress_conflict", 409);
      }
    }
  }

  const after = await takeLocks(courtDay.id);
  const saved = after.find((l: any) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  if (!saved) return err("take_lock_unavailable", 500);
  const progress = takeProgress(items, saved.answers, saved.completed_at);
  const state = await courtState(req, body, courtDay);
  const item = items[plan.item_index];
  const consensus = takeConsensus([item], after as any[])[0];
  return ok({
    locked: true,
    idempotent: !!plan.idempotent,
    date: courtDay.day,
    day: { id: courtDay.id, share_token: courtDay.share_token },
    item_id: item.id,
    item_index: plan.item_index,
    take_complete: progress.completed,
    next_item_id: progress.next_item_id,
    take_progress: progress,
    your_answers: saved.answers,
    consensus,
    consensus_gate: { have: consensus.total, honest_empty: consensus.total <= 1 },
    beats: state.beats,
    streak: state.streak,
    share: state.share,
  });
}

export async function actionCourtChallengeStart(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  if (!userId && !clientId) return err("identity_required", 400);
  const day = dayFromBody(body);
  const courtDay = await getOrCreateCourtDay(day);
  if (!courtDay) return err("court_day_unavailable", 500);
  const res = await actionStart(req, {
    ...body,
    challenge_id: courtDay.challenge_definition.challenge_id,
    share_token: courtDay.challenge_definition.share_token,
  });
  const data = await res.json();
  if (!data.ok) return json(data, res.status);
  const state = await courtState(req, body, courtDay);
  return ok({
    ...data,
    date: courtDay.day,
    court_day: { id: courtDay.id, share_token: courtDay.share_token },
    court_challenge: courtDay.challenge_definition,
    beats: state.beats,
    share: state.share,
    streak: state.streak,
  });
}

export async function actionCourtChallengeGuess(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  if (!userId && !clientId) return err("identity_required", 400);
  const day = dayFromBody(body);
  const courtDay = await getOrCreateCourtDay(day);
  if (!courtDay) return err("court_day_unavailable", 500);
  const { data: attempt } = await db.from("mp_attempts")
    .select("challenge_id")
    .eq("id", body.attempt_id ?? "")
    .maybeSingle();
  if (!attempt || attempt.challenge_id !== courtDay.challenge_definition.challenge_id) {
    return err("court_challenge_attempt_required", 403);
  }
  const res = await actionGuess(req, body);
  const data = await res.json();
  if (!data.ok) return json(data, res.status);
  const { matched_player_key: _privatePlayerKey, ...publicData } = data;
  const state = await courtState(req, body, courtDay);
  return ok({
    ...publicData,
    date: courtDay.day,
    court_day: { id: courtDay.id, share_token: courtDay.share_token },
    court_challenge: courtDay.challenge_definition,
    beats: state.beats,
    share: state.share,
    streak: state.streak,
  });
}
