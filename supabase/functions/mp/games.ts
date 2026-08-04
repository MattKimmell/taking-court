import {
  db, ok, err, authedUserId, safeClientId, normalize, randomToken,
  buildSnapshot, revealedAnswers, strikeContext, rankCompare, leaderboardCompare, isBotClient,
  ARENA_POOL, TEAM_POOL, insertBot, insertRosterBot, loadRosterPool, rosterReveal, RARITY_LABEL,
  matchPoolGuess,
} from "./shared.ts";
import type { SnapshotSlot, PoolEntry } from "./shared.ts";

// Fetch every row past PostgREST's 1000-row cap by paging. Used only for the
// autocomplete player pools (the full guessable universe); the client fetches
// these once per session and filters locally.
async function pagedRows(build: () => any): Promise<any[]> {
  const out: any[] = []; const size = 1000;
  for (let from = 0; from < 30000; from += size) {
    const { data, error } = await build().range(from, from + size - 1);
    if (error || !data || data.length === 0) break;
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Action handlers
// -----------------------------------------------------------------------------

export async function actionSheets() {
  const { data, error } = await db
    .from("perfect_sheets")
    .select("id, prompt, difficulty, answer_count, source_kind")
    .eq("status", "approved")
    .eq("answer_count", 8)
    .order("difficulty", { ascending: true });
  if (error) return err(error.message, 500);
  const top8 = (data ?? []).map((s) => ({ id: s.id, kind: "top8", prompt: s.prompt, difficulty: s.difficulty, answer_target: s.answer_count }));

  const { data: rosters } = await db
    .from("mp_roster_sheets")
    .select("id, prompt, difficulty, target")
    .eq("status", "approved")
    .order("difficulty", { ascending: true });
  const roster = (rosters ?? []).map((s) => ({ id: s.id, kind: "roster", prompt: s.prompt, difficulty: s.difficulty, answer_target: s.target }));

  return ok({ sheets: [...top8, ...roster] });
}

// Create a roster challenge: freeze the eligible pool + rarity, target = "name N".
export async function actionCreateRoster(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const mode = body.mode === "competition" ? "competition" : "duel";

  let rid: string | null = body.sheet_id ?? null;
  if (!rid) {
    const { data: pool } = await db.from("mp_roster_sheets").select("id").eq("status", "approved");
    if (!pool || pool.length === 0) return err("no_categories_available", 404);
    rid = pool[Math.floor(Math.random() * pool.length)].id;
  }
  const { data: sheet, error: sErr } = await db.from("mp_roster_sheets").select("id, prompt, target").eq("id", rid).single();
  if (sErr || !sheet) return err("category_not_found", 404);

  const pool = await loadRosterPool(sheet.id);
  if (pool.length < sheet.target) return err("category_incomplete", 500);

  const strikeLimit = Number.isFinite(body.strike_limit) ? Math.max(1, Math.floor(body.strike_limit)) : 3;
  const requireAuth = body.require_auth === true;
  const expiresDays = Number.isFinite(body.expires_in_days) ? Math.max(1, Math.floor(body.expires_in_days)) : 30;
  const maxParticipants = mode === "duel" ? 2 : (Number.isFinite(body.max_participants) ? Math.max(2, Math.floor(body.max_participants)) : null);
  if (requireAuth && !userId) return err("auth_required_for_this_challenge", 401);

  const shareToken = randomToken(9);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresDays * 86400000);

  const { data: challenge, error: cErr } = await db.from("mp_challenges").insert({
    share_token: shareToken, kind: "roster", roster_sheet_id: sheet.id, sheet_id: null, mode, status: "open",
    prompt: sheet.prompt, answer_target: sheet.target, question_version: 1, answers_snapshot: pool,
    strike_limit: strikeLimit, rules: { strike_limit: strikeLimit, answer_target: sheet.target, mode, kind: "roster" },
    max_participants: maxParticipants, require_auth: requireAuth,
    creator_client_id: clientId, creator_user_id: userId, creator_label: body.label ?? "Player A", expires_at: expiresAt.toISOString(),
  }).select("id, share_token, prompt, answer_target, strike_limit, mode, expires_at").single();
  if (cErr) return err(cErr.message, 500);

  const { data: attempt, error: atErr } = await db.from("mp_attempts").insert({
    challenge_id: challenge.id, role: "creator", player_client_id: clientId, player_user_id: userId, player_label: body.label ?? "Player A",
  }).select("id, attempt_token").single();
  if (atErr) return err(atErr.message, 500);

  let botLabel: string | null = null;
  if (body.vs === "computer") {
    const diff = ["easy", "medium", "hard"].includes(body.bot_difficulty) ? body.bot_difficulty : "medium";
    botLabel = await insertRosterBot(challenge.id, challenge.mode, pool, challenge.answer_target, strikeLimit, diff);
  }

  return ok({
    challenge_id: challenge.id, share_token: challenge.share_token, attempt_id: attempt.id, attempt_token: attempt.attempt_token,
    prompt: challenge.prompt, answer_target: challenge.answer_target, strike_limit: challenge.strike_limit, mode: challenge.mode,
    kind: "roster", expires_at: challenge.expires_at, has_bot: !!botLabel, bot_label: botLabel,
  });
}

export async function actionCreate(req: Request, body: any) {
  if (body.kind === "roster") return await actionCreateRoster(req, body);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) {
    return err("identity_required: pass client_id or authenticate", 400);
  }
  const mode = body.mode === "competition" ? "competition" : "duel";

  // choose category
  let sheetId: string | null = body.sheet_id ?? null;
  if (!sheetId) {
    const { data: pool } = await db
      .from("perfect_sheets")
      .select("id")
      .eq("status", "approved")
      .eq("answer_count", 8);
    if (!pool || pool.length === 0) return err("no_categories_available", 404);
    sheetId = pool[Math.floor(Math.random() * pool.length)].id;
  }

  const { data: sheet, error: sErr } = await db
    .from("perfect_sheets")
    .select("id, prompt, answer_count, source_as_of")
    .eq("id", sheetId)
    .single();
  if (sErr || !sheet) return err("category_not_found", 404);

  const snapshot = await buildSnapshot(sheet.id);
  if (snapshot.length !== sheet.answer_count) {
    return err("category_incomplete", 500);
  }

  const strikeLimit = Number.isFinite(body.strike_limit)
    ? Math.max(1, Math.floor(body.strike_limit))
    : 3;
  const requireAuth = body.require_auth === true;
  const expiresDays = Number.isFinite(body.expires_in_days)
    ? Math.max(1, Math.floor(body.expires_in_days))
    : 30;
  const maxParticipants =
    mode === "duel" ? 2 : (Number.isFinite(body.max_participants)
      ? Math.max(2, Math.floor(body.max_participants))
      : null);

  if (requireAuth && !userId) {
    return err("auth_required_for_this_challenge", 401);
  }

  const shareToken = randomToken(9);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresDays * 86400000);

  const { data: challenge, error: cErr } = await db
    .from("mp_challenges")
    .insert({
      share_token: shareToken,
      sheet_id: sheet.id,
      mode,
      status: "open",
      prompt: sheet.prompt,
      answer_target: sheet.answer_count,
      question_version: 1,
      answers_snapshot: snapshot,
      source_data_asof: sheet.source_as_of ?? null,
      strike_limit: strikeLimit,
      rules: { strike_limit: strikeLimit, answer_target: sheet.answer_count, mode },
      max_participants: maxParticipants,
      require_auth: requireAuth,
      creator_client_id: clientId,
      creator_user_id: userId,
      creator_label: body.label ?? "Player A",
      expires_at: expiresAt.toISOString(),
    })
    .select("id, share_token, prompt, answer_target, strike_limit, mode, expires_at")
    .single();
  if (cErr) return err(cErr.message, 500);

  // creator's own attempt (timer not started until they reveal / first guess)
  const { data: attempt, error: atErr } = await db
    .from("mp_attempts")
    .insert({
      challenge_id: challenge.id,
      role: "creator",
      player_client_id: clientId,
      player_user_id: userId,
      player_label: body.label ?? "Player A",
    })
    .select("id, attempt_token")
    .single();
  if (atErr) return err(atErr.message, 500);

  // Optional computer opponent. Its result stays hidden from the creator until
  // they finish (revealed only through `results`), so no information leaks here.
  let botLabel: string | null = null;
  if (body.vs === "computer") {
    const diff = ["easy", "medium", "hard"].includes(body.bot_difficulty) ? body.bot_difficulty : "medium";
    botLabel = await insertBot(challenge.id, challenge.mode, snapshot, challenge.answer_target, strikeLimit, diff);
  }

  return ok({
    challenge_id: challenge.id,
    share_token: challenge.share_token,
    attempt_id: attempt.id,
    attempt_token: attempt.attempt_token,
    prompt: challenge.prompt,
    answer_target: challenge.answer_target,
    strike_limit: challenge.strike_limit,
    mode: challenge.mode,
    expires_at: challenge.expires_at,
    has_bot: !!botLabel,
    bot_label: botLabel,   // just the name/difficulty, never its score
  });
}

// Add a computer opponent to an existing challenge (e.g. from a rematch or if
// the human wants a bot to race). Returns only the label, never the bot result.
export async function actionAddBot(_req: Request, body: any) {
  const { challenge, error: cErr } = await loadChallenge(body);
  if (cErr) return err(cErr, 404);
  const diff = ["easy", "medium", "hard"].includes(body.bot_difficulty) ? body.bot_difficulty : "medium";

  // respect duel capacity (bot takes a seat)
  const { data: attempts } = await db.from("mp_attempts").select("id").eq("challenge_id", challenge.id);
  if (challenge.max_participants != null && (attempts?.length ?? 0) >= challenge.max_participants) {
    return err("challenge_full", 409);
  }
  if (challenge.kind === "roster") {
    const pool = await loadRosterPool(challenge.roster_sheet_id);
    const rlabel = await insertRosterBot(challenge.id, challenge.mode, pool, challenge.answer_target, challenge.strike_limit, diff);
    return ok({ bot_added: true, bot_label: rlabel });
  }
  const label = await insertBot(
    challenge.id, challenge.mode, challenge.answers_snapshot as SnapshotSlot[],
    challenge.answer_target, challenge.strike_limit, diff,
  );
  return ok({ bot_added: true, bot_label: label });
}

export async function loadChallenge(body: any) {
  let q = db.from("mp_challenges").select("*");
  if (body.challenge_id) q = q.eq("id", body.challenge_id);
  else if (body.share_token) q = q.eq("share_token", body.share_token);
  else return { challenge: null, error: "missing_challenge_ref" };
  const { data, error } = await q.single();
  if (error || !data) return { challenge: null, error: "challenge_not_found" };
  return { challenge: data, error: null };
}

export async function actionOpen(req: Request, body: any) {
  const { challenge, error: cErr } = await loadChallenge(body);
  if (cErr) return err(cErr, 404);

  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;

  const { data: attempts } = await db
    .from("mp_attempts")
    .select("id, role, player_label, status, player_client_id, player_user_id, started_at")
    .eq("challenge_id", challenge.id);

  const started = (attempts ?? []).filter((a) => a.started_at);
  const mine = (attempts ?? []).find(
    (a) =>
      (userId && a.player_user_id === userId) ||
      (clientId && a.player_client_id === clientId),
  );

  return ok({
    challenge: {
      id: challenge.id,
      share_token: challenge.share_token,
      prompt: challenge.prompt,
      answer_target: challenge.answer_target,
      strike_limit: challenge.strike_limit,
      mode: challenge.mode,
      kind: challenge.kind ?? "top8",
      status: challenge.status,
      require_auth: challenge.require_auth,
      max_participants: challenge.max_participants,
      participant_count: started.length,
      expires_at: challenge.expires_at,
      expired: new Date(challenge.expires_at).getTime() < Date.now(),
    },
    // Only ever returns the *caller's own* attempt summary; never answers,
    // never other players.
    your_attempt: mine
      ? {
          id: mine.id,
          role: mine.role,
          status: mine.status,
          started: !!mine.started_at,
        }
      : null,
  });
}

export async function actionStart(req: Request, body: any) {
  const { challenge, error: cErr } = await loadChallenge(body);
  if (cErr) return err(cErr, 404);

  if (challenge.status !== "open") return err("challenge_closed", 409);
  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    return err("challenge_expired", 409);
  }

  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  if (challenge.require_auth && !userId) {
    return err("auth_required_for_this_challenge", 401);
  }

  const { data: attempts } = await db
    .from("mp_attempts")
    .select("id, attempt_token, role, status, started_at, correct_count, strikes, filled_slots, player_client_id, player_user_id")
    .eq("challenge_id", challenge.id);

  let mine = (attempts ?? []).find(
    (a) =>
      (userId && a.player_user_id === userId) ||
      (clientId && a.player_client_id === clientId),
  );

  // join if this identity has no attempt yet
  if (!mine) {
    const startedCount = (attempts ?? []).length;
    if (
      challenge.max_participants != null &&
      startedCount >= challenge.max_participants
    ) {
      return err("challenge_full", 409);
    }
    const role = challenge.mode === "duel" ? "opponent" : "participant";
    const { data: created, error: jErr } = await db
      .from("mp_attempts")
      .insert({
        challenge_id: challenge.id,
        role,
        player_client_id: clientId,
        player_user_id: userId,
        player_label: body.label ?? (role === "opponent" ? "Player B" : "Player"),
      })
      .select("id, attempt_token, role, status, started_at, correct_count, strikes, filled_slots")
      .single();
    if (jErr) {
      // unique-violation race: someone created it concurrently — refetch
      const { data: again } = await db
        .from("mp_attempts")
        .select("id, attempt_token, role, status, started_at, correct_count, strikes, filled_slots, player_client_id, player_user_id")
        .eq("challenge_id", challenge.id);
      mine = (again ?? []).find(
        (a) =>
          (userId && a.player_user_id === userId) ||
          (clientId && a.player_client_id === clientId),
      );
      if (!mine) return err(jErr.message, 500);
    } else {
      mine = created as any;
    }
  }

  // start the server clock (idempotent — never resets a running timer)
  if (!mine.started_at && mine.status === "in_progress") {
    const nowIso = new Date().toISOString();
    const { data: upd } = await db
      .from("mp_attempts")
      .update({ started_at: nowIso, updated_at: nowIso })
      .eq("id", mine.id)
      .is("started_at", null)
      .select("started_at")
      .single();
    if (upd) mine.started_at = upd.started_at;
    // also stamp the challenge's first-start, for reference
    if (!challenge.starts_at) {
      await db
        .from("mp_challenges")
        .update({ starts_at: nowIso })
        .eq("id", challenge.id)
        .is("starts_at", null);
    }
  }

  return ok({
    challenge_id: challenge.id,
    attempt_id: mine.id,
    attempt_token: mine.attempt_token,
    role: mine.role,
    prompt: challenge.prompt,
    answer_target: challenge.answer_target,
    strike_limit: challenge.strike_limit,
    mode: challenge.mode,
    kind: challenge.kind ?? "top8",
    status: mine.status,
    started_at: mine.started_at,
    correct_count: mine.correct_count ?? 0,
    strikes: mine.strikes ?? 0,
    filled_slots: mine.filled_slots ?? {},
  });
}

export async function actionGuess(_req: Request, body: any) {
  const attemptId = body.attempt_id;
  const attemptToken = body.attempt_token;
  const rawGuess: string = body.guess ?? "";
  if (!attemptId || !attemptToken) return err("missing_attempt_credentials", 400);

  const { data: attempt, error: atErr } = await db
    .from("mp_attempts")
    .select("*")
    .eq("id", attemptId)
    .single();
  if (atErr || !attempt) return err("attempt_not_found", 404);
  if (attempt.attempt_token !== attemptToken) return err("bad_attempt_token", 403);

  const { data: challenge } = await db
    .from("mp_challenges")
    .select("*")
    .eq("id", attempt.challenge_id)
    .single();
  if (!challenge) return err("challenge_not_found", 404);

  const now = new Date();

  // expire mid-game if past deadline
  if (
    attempt.status === "in_progress" &&
    new Date(challenge.expires_at).getTime() < now.getTime()
  ) {
    const startedMs = attempt.started_at ? new Date(attempt.started_at).getTime() : now.getTime();
    const rankTime = attempt.last_correct_at
      ? new Date(attempt.last_correct_at).getTime() - startedMs
      : 0;
    await db.from("mp_attempts").update({
      status: "expired",
      finished_at: now.toISOString(),
      elapsed_ms: now.getTime() - startedMs,
      ranking_time_ms: rankTime,
      updated_at: now.toISOString(),
    }).eq("id", attempt.id);
    return err("challenge_expired", 409);
  }

  if (attempt.status !== "in_progress") {
    return ok({
      result: "already_finished",
      status: attempt.status,
      correct_count: attempt.correct_count,
      strikes: attempt.strikes,
      strikes_remaining: challenge.strike_limit - attempt.strikes,
      answer_target: challenge.answer_target,
      filled_slots: attempt.filled_slots,
      finished: true,
    });
  }

  // auto-start the clock on first guess if not already started
  let startedAt = attempt.started_at;
  if (!startedAt) {
    startedAt = now.toISOString();
  }
  const startedMs = new Date(startedAt).getTime();
  const atMs = now.getTime() - startedMs;

  const isRoster = challenge.kind === "roster";
  const snapshot = challenge.answers_snapshot as any[];
  const filled = { ...(attempt.filled_slots as Record<string, any>) };
  const guesses = [...(attempt.guesses as any[])];
  const norm = normalize(rawGuess);
  if (!norm) return err("empty_guess", 400);

  const priorNorms = new Set(guesses.map((g) => g.normalized));
  let correctCount = attempt.correct_count;
  let strikes = attempt.strikes;
  let lastCorrectAt = attempt.last_correct_at;
  let result: "correct" | "strike" | "duplicate" = "strike";
  let matchedSlot: number | null = null;
  let matchedName: string | null = null;
  let matchedContext: string | null = null;
  let rarityInfo: any = null;

  if (isRoster) {
    // pool game: any un-used pool member fills the next open slot (1..target)
    const usedKeys = new Set(Object.values(filled).map((f: any) => f.player_key));
    const hit = matchPoolGuess(snapshot as PoolEntry[], norm);
    if (hit) {
      if (usedKeys.has(hit.player_key)) {
        result = "duplicate"; matchedName = hit.display_name;
      } else {
        result = "correct"; matchedName = hit.display_name;
        let slot = 1; while (filled[String(slot)]) slot++;
        matchedSlot = slot;
        matchedContext = RARITY_LABEL[hit.rarity_tier] ?? hit.rarity_tier;
        filled[String(slot)] = { name: hit.display_name, player_key: hit.player_key, at_ms: atMs, rarity_tier: hit.rarity_tier };
        correctCount += 1; lastCorrectAt = now.toISOString();
        // live crowd pick-rate (once enough games have been played)
        let pickPct: number | null = null;
        try {
          const { data: bp } = await db.rpc("mp_roster_bump_pick", { p_sheet: challenge.roster_sheet_id, p_player: hit.player_key });
          const rowp = Array.isArray(bp) ? bp[0] : bp;
          if (rowp && rowp.plays >= 15) pickPct = Math.max(1, Math.min(100, Math.round((rowp.picks * 100) / rowp.plays)));
        } catch { /* pick tracking is best-effort */ }
        rarityInfo = { rarity_tier: hit.rarity_tier, rarity_label: RARITY_LABEL[hit.rarity_tier] ?? hit.rarity_tier, pick_pct: pickPct };
      }
    } else {
      if (priorNorms.has(norm)) result = "duplicate";
      else { result = "strike"; strikes += 1; }
    }
  } else {
    const hit = (snapshot as SnapshotSlot[]).find((s) => s.accepted.includes(norm));
    if (hit) {
      if (filled[String(hit.slot)]) { result = "duplicate"; matchedSlot = hit.slot; matchedName = hit.display_name; }
      else {
        result = "correct"; matchedSlot = hit.slot; matchedName = hit.display_name; matchedContext = hit.context_label;
        filled[String(hit.slot)] = { name: hit.display_name, at_ms: atMs };
        correctCount += 1; lastCorrectAt = now.toISOString();
      }
    } else {
      if (priorNorms.has(norm)) result = "duplicate";
      else { result = "strike"; strikes += 1; }
    }
  }

  guesses.push({ seq: guesses.length + 1, at_ms: atMs, raw: rawGuess, normalized: norm, result, slot: matchedSlot });

  let status = attempt.status;
  let finishedAt: string | null = null;
  let elapsedMs: number | null = null;
  let rankingTimeMs: number | null = null;
  if (result === "correct" && correctCount >= challenge.answer_target) {
    status = "completed"; finishedAt = now.toISOString(); elapsedMs = atMs; rankingTimeMs = atMs;
  } else if (result === "strike" && strikes >= challenge.strike_limit) {
    status = "eliminated"; finishedAt = now.toISOString(); elapsedMs = atMs;
    rankingTimeMs = lastCorrectAt ? new Date(lastCorrectAt).getTime() - startedMs : 0;
  }

  const patch: Record<string, unknown> = {
    started_at: startedAt, correct_count: correctCount, strikes, filled_slots: filled, guesses,
    last_correct_at: lastCorrectAt, status, updated_at: now.toISOString(),
  };
  if (finishedAt) { patch.finished_at = finishedAt; patch.elapsed_ms = elapsedMs; patch.ranking_time_ms = rankingTimeMs; }
  const { error: uErr } = await db.from("mp_attempts").update(patch).eq("id", attempt.id);
  if (uErr) return err(uErr.message, 500);

  const finished = status !== "in_progress";
  if (isRoster && finished && challenge.roster_sheet_id) {
    try { await db.rpc("mp_roster_bump_play", { p_sheet: challenge.roster_sheet_id }); } catch { /* best-effort */ }
  }

  // near-miss context (top8 metric categories only)
  const guessInfo = (!isRoster && result === "strike") ? await strikeContext(challenge, rawGuess) : null;
  const reveal = finished ? (isRoster ? rosterReveal(snapshot as PoolEntry[]) : revealedAnswers(snapshot as SnapshotSlot[])) : undefined;

  return ok({
    result,
    slot: matchedSlot,
    display_name: result === "correct" ? matchedName : undefined,
    context_label: result === "correct" ? matchedContext : undefined,
    guess_info: guessInfo ?? undefined,
    rarity: rarityInfo ?? undefined,
    correct_count: correctCount,
    strikes,
    strikes_remaining: challenge.strike_limit - strikes,
    answer_target: challenge.answer_target,
    at_ms: atMs,
    filled_slots: filled,
    status,
    finished,
    elapsed_ms: elapsedMs ?? undefined,
    ranking_time_ms: rankingTimeMs ?? undefined,
    revealed_answers: reveal,
  });
}

export async function actionResults(_req: Request, body: any) {
  const { challenge, error: cErr } = await loadChallenge(body);
  if (cErr) return err(cErr, 404);

  const { data: reqAttempt } = await db
    .from("mp_attempts")
    .select("*")
    .eq("id", body.attempt_id ?? "")
    .maybeSingle();
  if (!reqAttempt || reqAttempt.challenge_id !== challenge.id) {
    return err("attempt_not_found", 404);
  }
  if (reqAttempt.attempt_token !== (body.attempt_token ?? "")) {
    return err("bad_attempt_token", 403);
  }

  const challengeClosed =
    challenge.status === "closed" ||
    new Date(challenge.expires_at).getTime() < Date.now();
  const requesterFinished = reqAttempt.status !== "in_progress";

  // Suspense guard: you can't see anyone else's result until you're done
  // (or the whole challenge has closed).
  if (!requesterFinished && !challengeClosed) {
    return err("finish_first", 403, { your_status: reqAttempt.status });
  }

  const { data: allAttempts } = await db
    .from("mp_attempts")
    .select("*")
    .eq("challenge_id", challenge.id);

  const started = (allAttempts ?? []).filter((a) => a.started_at);
  const ranked = started.slice().sort(rankCompare);

  // persist ranks
  for (let i = 0; i < ranked.length; i++) {
    const wantRank = i + 1;
    if (ranked[i].rank !== wantRank) {
      await db.from("mp_attempts").update({ rank: wantRank }).eq("id", ranked[i].id);
      ranked[i].rank = wantRank;
    }
  }

  const allFinished =
    started.length > 0 && started.every((a) => a.status !== "in_progress");

  // winner: only declared when every started participant is finished
  let winner: { type: string; attempt_id?: string } = { type: "pending" };
  if (challengeClosed || allFinished) {
    if (ranked.length === 0) winner = { type: "none" };
    // One attempt is not a victory. This used to return type "attempt", which
    // made the sole player the winner by default -- so a solo run that struck
    // out at 3 of 8 still rendered "🏆 You win!". A solo run has no opponent, so
    // the outcome is performance against the sheet, and "solo" says so
    // explicitly rather than leaving the client to infer it from a count.
    // A bot opponent is a real second attempt, so vs-computer is unaffected.
    else if (ranked.length === 1) winner = { type: "solo", attempt_id: ranked[0].id };
    else {
      const tie = rankCompare(ranked[0], ranked[1]) === 0;
      winner = tie ? { type: "draw" } : { type: "attempt", attempt_id: ranked[0].id };
    }
  }

  const snapshot = challenge.answers_snapshot as any[];
  const reveal = challenge.kind === "roster"
    ? rosterReveal(snapshot as PoolEntry[])
    : revealedAnswers(snapshot as SnapshotSlot[]);

  const participants = ranked.map((a) => {
    const isRequester = a.id === reqAttempt.id;
    const visible = isRequester || a.status !== "in_progress" || challengeClosed;
    if (!visible) {
      return {
        attempt_id: a.id,
        player_label: a.player_label,
        role: a.role,
        hidden: true,
        status: "in_progress",
      };
    }
    return {
      attempt_id: a.id,
      player_label: a.player_label,
      role: a.role,
      hidden: false,
      status: a.status,
      completed: a.status === "completed",
      correct_count: a.correct_count,
      strikes: a.strikes,
      strike_limit: challenge.strike_limit,
      elapsed_ms: a.elapsed_ms,
      ranking_time_ms: a.ranking_time_ms,
      rank: a.rank,
      is_you: isRequester,
    };
  });

  return ok({
    challenge_id: challenge.id,
    mode: challenge.mode,
    kind: challenge.kind ?? "top8",
    status: challenge.status,
    prompt: challenge.prompt,
    answer_target: challenge.answer_target,
    strike_limit: challenge.strike_limit,
    all_finished: allFinished,
    winner,
    participants,
    your_attempt_id: reqAttempt.id,
    revealed_answers: reveal,
  });
}

// Global / per-category leaderboard. Ranks finished attempts by completion then
// completion time. Only ever exposes finished attempts (never in-progress, so no
// live game is leaked), aggregate stats only (labels + times, never answers).
export async function actionLeaderboard(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const includeBots = body.include_bots === true;
  const limit = Number.isFinite(body.limit) ? Math.min(100, Math.max(1, Math.floor(body.limit))) : 20;

  // pagedRows, not a bare select: PostgREST caps a response at max_rows = 1000,
  // so this silently dropped every attempt past the first thousand and then
  // ranked the truncated set — a leaderboard that is quietly wrong rather than
  // visibly broken. Filters are pushed into the query for the same reason:
  // filtering in JS after truncation filters the wrong thousand rows.
  const sheet = body.sheet_id ? String(body.sheet_id) : null;
  const data = await pagedRows(() => {
    let q = db.from("mp_attempts")
      .select("id, player_label, player_client_id, player_user_id, status, correct_count, strikes, elapsed_ms, ranking_time_ms, finished_at, challenge:mp_challenges!inner(prompt, sheet_id, roster_sheet_id, answer_target)")
      .in("status", ["completed", "eliminated", "expired"])
      .not("finished_at", "is", null);
    // A sheet id can be either a trivia sheet or a roster sheet, so match either
    // side. .or() takes a raw string, hence the strict uuid guard above/below.
    if (sheet && /^[0-9a-fA-F-]{36}$/.test(sheet)) {
      q = q.or(`sheet_id.eq.${sheet},roster_sheet_id.eq.${sheet}`, { referencedTable: "mp_challenges" });
    }
    return q;
  });

  let rows = data;
  if (!includeBots) rows = rows.filter((r: any) => !isBotClient(r.player_client_id));

  rows.sort(leaderboardCompare);
  const top = rows.slice(0, limit).map((r: any, i: number) => ({
    rank: i + 1,
    player_label: r.player_label,
    is_bot: isBotClient(r.player_client_id),
    is_you: (userId && r.player_user_id === userId) || (clientId && r.player_client_id === clientId) || false,
    completed: r.status === "completed",
    status: r.status,
    correct_count: r.correct_count,
    answer_target: r.challenge?.answer_target ?? 8,
    strikes: r.strikes,
    time_ms: r.status === "completed" ? r.elapsed_ms : r.ranking_time_ms,
    category: r.challenge?.prompt ?? null,
    finished_at: r.finished_at,
  }));

  return ok({ scope: body.sheet_id ? "category" : "global", count: rows.length, entries: top });
}

// Typeahead pool for a challenge's category. Returns the guessable universe
// (all notable players, or all arenas) — never the answer set — so the client
// can render an autocomplete without leaking which names are correct.
// broad player universe — shared by roster games and subjective lists
export async function playerPool() {
  const data = await pagedRows(() => db
    .from("vw_trivia_player_career_summary")
    .select("player_name, games_played")
    .eq("season_type", "REGULAR")
    .order("games_played", { ascending: false }));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of data) { if (r.player_name && !seen.has(r.player_name)) { seen.add(r.player_name); names.push(r.player_name); } }
  return ok({ type: "player", items: names });
}

export async function actionSuggest(_req: Request, body: any) {
  if (body.pool === "players") return await playerPool();   // challenge-less (lists)
  if (body.pool === "teams") return ok({ type: "team", items: TEAM_POOL });
  let sheetId: string | null = body.sheet_id ?? null;
  let kind = "top8";
  if (body.challenge_id || body.share_token) {
    const { challenge } = await loadChallenge(body);
    if (challenge) { kind = challenge.kind ?? "top8"; if (!sheetId) sheetId = challenge.sheet_id; }
  }

  // Roster: broad player universe (never the eligible pool — that would leak
  // the answers). Wide net so obscure but valid picks can still be typed.
  if (kind === "roster") {
    const data = await pagedRows(() => db
      .from("vw_trivia_player_career_summary")
      .select("player_name, games_played")
      .eq("season_type", "REGULAR")
      .order("games_played", { ascending: false }));
    const seen = new Set<string>();
    const names: string[] = [];
    for (const r of data) { if (r.player_name && !seen.has(r.player_name)) { seen.add(r.player_name); names.push(r.player_name); } }
    return ok({ type: "player", items: names });
  }

  if (!sheetId) return err("missing_sheet_ref", 400);

  const { data: sheet } = await db
    .from("perfect_sheets")
    .select("source_params")
    .eq("id", sheetId)
    .single();
  const metric = (sheet?.source_params as Record<string, unknown> | null)?.metric;

  if (metric === "arenacapacity") {
    return ok({ type: "arena", items: ARENA_POOL });
  }

  // player categories: notable players from the public career-summary view.
  // Paged past PostgREST's 1000-row cap so every player is typeable.
  const data = await pagedRows(() => db
    .from("vw_trivia_player_career_summary")
    .select("player_name, career_points")
    .eq("season_type", "REGULAR")
    .order("career_points", { ascending: false }));

  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of data ?? []) {
    if (r.player_name && !seen.has(r.player_name)) {
      seen.add(r.player_name);
      names.push(r.player_name);
    }
  }
  return ok({ type: "player", items: names });
}


// The "Name It" browse screen: one curated catalogue of recall challenges,
// grouped into categories, with a single featured hero.
//
// Returned in ONE round trip with items nested under their category. That is a
// deliberate call at this size -- the whole catalogue is ~15 rows, so paging or
// a per-category fetch would cost more requests than it saves bytes. Revisit if
// the filtered generator (team / G-F-C / decade) starts producing hundreds.
//
// Reads the mp_challenge_catalog layer rather than perfect_sheets directly, so
// `title` can show "Career points" where the underlying prompt says "Name the 8
// players with the most career points (NBA regular season)." -- the prompt still
// governs play, this only governs browse.
export async function actionChallengeCatalog() {
  const [{ data: cats }, { data: rows }] = await Promise.all([
    db.from("mp_challenge_categories")
      .select("slug, label, blurb, icon, sort_order")
      .eq("status", "approved").order("sort_order", { ascending: true }),
    db.from("mp_challenge_catalog")
      .select("kind, sheet_id, roster_sheet_id, category_slug, title, blurb, featured, sort_order, " +
              "group_key, group_label, group_order, " +
              "sheet:perfect_sheets(prompt, difficulty, answer_count), " +
              "roster:mp_roster_sheets(prompt, difficulty, target)")
      .eq("status", "approved")
      .order("group_order", { ascending: true, nullsFirst: true })
      .order("sort_order", { ascending: true }),
  ]);

  const shape = (r: any) => {
    const src = r.kind === "sheet" ? r.sheet : r.roster;
    return {
      kind: r.kind,
      sheet_id: r.sheet_id ?? r.roster_sheet_id,   // the client passes this straight back to `create`
      category: r.category_slug,
      title: r.title ?? src?.prompt ?? "Challenge",
      blurb: r.blurb ?? null,
      prompt: src?.prompt ?? null,
      difficulty: src?.difficulty ?? null,
      answer_count: r.kind === "sheet" ? (src?.answer_count ?? null) : (src?.target ?? null),
      featured: !!r.featured,
      // Optional browse axis. When present the client renders a picker for the
      // group first (team today, decade next) instead of a flat list. Kept
      // generic so a new axis needs no client change.
      group_key: r.group_key ?? null,
      group_label: r.group_label ?? null,
    };
  };

  const all = (rows ?? []).map(shape);
  // An ARRAY as of 0033. One hero was the right call for tier themes, where a
  // consensus gate needs three boards on the same set — concentrating attention
  // is what clears it. A recall challenge has no gate, so a single pick buys
  // nothing and costs the shelf variety at the top. `featured_one` keeps the old
  // single-object contract alive for shells cached before this shipped.
  const featured = all.filter((x) => x.featured);
  const categories = (cats ?? []).map((c) => {
    const items = all.filter((x) => x.category === c.slug);
    // Distinct groups in payload order, so the client can render a picker
    // without re-sorting. Empty when the category is ungrouped.
    const seen = new Set<string>();
    const groups: { key: string; label: string; n: number }[] = [];
    for (const it of items) {
      if (!it.group_key || seen.has(it.group_key)) continue;
      seen.add(it.group_key);
      groups.push({ key: it.group_key, label: it.group_label ?? it.group_key,
                    n: items.filter((y) => y.group_key === it.group_key).length });
    }
    return { slug: c.slug, label: c.label, blurb: c.blurb, icon: c.icon, items, groups };
  }).filter((c) => c.items.length > 0);

  return ok({ featured, featured_one: featured[0] ?? null, categories, total: all.length });
}

// Playability check for a filtered challenge, before the player commits to it.
//
// Delegates the counting to public.mp_challenge_preview, which does the base
// counts AND the "which filter should I drop" probes inside a single call. Doing
// the probes here would be one round trip each.
//
// Filters are whitelisted before they go anywhere. The rpc argument is
// parameterised so injection is not the risk; the risk is a typo silently
// counting zero and reading as "impossible", which would be indistinguishable
// from a genuinely empty combination.
const PREVIEW_AWARDS = new Set(["mvp","dpoy","roy","smoy","mip","allnba","alldef","allstar","allstar10","hof","ring"]);
const PREVIEW_DRAFT  = new Set(["first","top3","lottery","round1","round2"]);
const PREVIEW_DECADES = new Set([1940,1950,1960,1970,1980,1990,2000,2010,2020]);
// Conferences are a closed set, so they get enumerated like every other
// controlled vocabulary here. Colleges are not — there are 554 of them and the
// list grows with the data — so those get shape validation, and a value that is
// well-formed but unknown is caught by mp_challenge_preview, which reports
// `unknown_filter` rather than letting it read as an empty combination.
const PREVIEW_CONFERENCES = new Set(["ACC","SEC","Big Ten","Big 12","Big East","Pac-12"]);
const COLLEGE_SHAPE = /^[A-Za-z0-9 .'()&-]{2,40}$/;

export function buildChallengeFilters(body: any): { filters: Record<string, unknown> } | { error: string } {
  const f: Record<string, unknown> = {};
  const mode = String(body.mode ?? "roster");
  if (mode !== "roster" && mode !== "top8") return { error: "bad_mode" };
  f.mode = mode;

  if (body.team != null && body.team !== "") {
    const t = String(body.team).toUpperCase();
    if (!/^[A-Z]{3}$/.test(t)) return { error: "bad_team" };
    f.team = t;
  }
  if (body.position != null && body.position !== "") {
    const p = String(body.position).toUpperCase();
    // G/F/C only. The data has no PG/SG/SF/PF anywhere, so accepting one would
    // silently return nothing and look like a bug.
    if (!["G","F","C"].includes(p)) return { error: "bad_position" };
    f.position = p;
  }
  if (body.decade != null && body.decade !== "") {
    const d = Math.floor(Number(body.decade));
    if (!PREVIEW_DECADES.has(d)) return { error: "bad_decade" };
    f.decade = d;
  }
  if (body.award != null && body.award !== "") {
    const a = String(body.award);
    if (!PREVIEW_AWARDS.has(a)) return { error: "bad_award" };
    f.award = a;
  }
  if (body.draft != null && body.draft !== "") {
    const d = String(body.draft);
    if (!PREVIEW_DRAFT.has(d)) return { error: "bad_draft" };
    f.draft = d;
  }
  if (body.college != null && body.college !== "") {
    const c = String(body.college).trim();
    if (!COLLEGE_SHAPE.test(c)) return { error: "bad_college" };
    f.college = c;
  }
  if (body.conference != null && body.conference !== "") {
    const c = String(body.conference);
    if (!PREVIEW_CONFERENCES.has(c)) return { error: "bad_conference" };
    f.conference = c;
  }
  if (body.target != null) {
    const n = Math.floor(Number(body.target));
    if (!Number.isFinite(n) || n < 3 || n > 15) return { error: "bad_target" };
    f.target = n;
  }
  if (body.deep_cuts === true) f.min_notability = 0;   // "include the obscure ones"
  return { filters: f };
}

// The two open-ended dropdowns. Colleges are data, not a constant, so the client
// cannot hardcode them the way it hardcodes teams and decades — and 554 of them
// is a phone book, so the server returns only the ones that could make a game.
// One call, cached client-side for the session.
export async function actionChallengeFilters() {
  const { data, error } = await db.rpc("mp_filter_options");
  if (error) return err(error.message, 500);
  return ok(data);
}

export async function actionChallengePreview(_req: Request, body: any) {
  const built = buildChallengeFilters(body);
  if ("error" in built) return err(built.error, 400);
  const { data, error } = await db.rpc("mp_challenge_preview", { f: built.filters });
  if (error) return err(error.message, 500);
  return ok({ filters: built.filters, preview: data });
}

// ---------------------------------------------------------------------------
// Build a challenge from filters.
//
// Roster (set-membership) mode only. Filtered top-N is NOT possible yet: a top8
// challenge takes its answers from perfect_sheet_answers via buildSnapshot, and
// perfect_sheets belongs to another app that shares this database — generating
// into it would mean writing to someone else's schema. Doing filtered top-N
// properly means building the snapshot directly at challenge-creation time and
// skipping sheets entirely. Deliberately left for later rather than half-built.
const TEAM_NAMES: Record<string, string> = {
  ATL:"Hawks", BOS:"Celtics", BRK:"Nets", CHO:"Hornets", CHI:"Bulls", CLE:"Cavaliers",
  DAL:"Mavericks", DEN:"Nuggets", DET:"Pistons", GSW:"Warriors", HOU:"Rockets",
  IND:"Pacers", LAC:"Clippers", LAL:"Lakers", MEM:"Grizzlies", MIA:"Heat", MIL:"Bucks",
  MIN:"Timberwolves", NOP:"Pelicans", NYK:"Knicks", OKC:"Thunder", ORL:"Magic",
  PHI:"76ers", PHO:"Suns", POR:"Trail Blazers", SAC:"Kings", SAS:"Spurs", TOR:"Raptors",
  UTA:"Jazz", WAS:"Wizards", SEA:"Seattle SuperSonics", NJN:"New Jersey Nets",
  WSB:"Washington Bullets", CHH:"Charlotte Hornets", VAN:"Vancouver Grizzlies",
  BUF:"Buffalo Braves",
};
const POS_PLURAL: Record<string, string> = { G: "guards", F: "forwards", C: "centers" };
// Each award phrase completes "...who ___".
const AWARD_PHRASE: Record<string, string> = {
  mvp: "won MVP", dpoy: "won Defensive Player of the Year", roy: "won Rookie of the Year",
  smoy: "won Sixth Man of the Year", mip: "won Most Improved Player",
  allnba: "made an All-NBA team", alldef: "made an All-Defensive team",
  allstar: "made an All-Star team", allstar10: "made 10 or more All-Star teams",
  hof: "are in the Hall of Fame", ring: "won a championship",
};
const DRAFT_PHRASE: Record<string, string> = {
  first: "were drafted first overall", top3: "were drafted in the top 3",
  lottery: "were lottery picks", round1: "were first-round picks",
  round2: "were second-round picks",
};

// Readable English from a filter set. Worth the fiddliness: the prompt is the
// whole game, and "Name 8 players position=G team=LAL" would be unplayable as a
// piece of writing even if the answers were right.
// The describing half, shared so the two prompt forms below cannot drift apart
// and start describing the same filter set differently.
function filterPhrase(f: Record<string, any>): string {
  const noun = f.position ? POS_PLURAL[f.position] : "players";
  const clauses: string[] = [];
  if (f.team) clauses.push(`played for the ${TEAM_NAMES[f.team] ?? f.team}`);
  // "went to Duke" / "came out of the Big East" — both read as natural speech,
  // which matters more here than consistency of construction. All six
  // conferences take a definite article.
  if (f.college) clauses.push(`went to ${f.college}`);
  if (f.conference) clauses.push(`came out of the ${f.conference}`);
  if (f.award) clauses.push(AWARD_PHRASE[f.award]);
  if (f.draft) clauses.push(DRAFT_PHRASE[f.draft]);
  let s = noun;
  if (clauses.length) s += ` who ${clauses.join(" and ")}`;
  if (f.decade) s += `${clauses.length ? " and were" : " who were"} active in the ${f.decade}s`;
  return s;
}

export function composeFilterPrompt(f: Record<string, any>, target: number): string {
  return `Name ${target} ${filterPhrase(f)}.`;
}

// Pickup prompts are noun phrases, not imperatives — "Players with 20,000+ career
// points" — because that screen renders the target separately and the room is
// looking at a board, not reading an instruction.
export function composeFilterSubject(f: Record<string, any>): string {
  const s = filterPhrase(f);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function actionChallengeBuild(req: Request, body: any) {
  const built = buildChallengeFilters(body);
  if ("error" in built) return err(built.error, 400);
  const filters = built.filters;
  if (filters.mode === "top8") return err("top8_filters_unsupported", 400);

  // Preview first, always. The same predicate backs the count and the generated
  // pool, so a verdict of ok here means the sheet really will have that many.
  const { data: pv, error: pErr } = await db.rpc("mp_challenge_preview", { f: filters });
  if (pErr) return err(pErr.message, 500);
  if (pv.verdict === "impossible") {
    return ok({ built: false, preview: pv, filters });   // 200: a dead end is an answer, not a fault
  }
  // Honour the clamp — the preview already reduced the ask to what exists.
  const target = pv.target as number;
  const prompt = composeFilterPrompt(filters as any, target);

  const { data: sheetId, error: bErr } = await db.rpc("mp_build_filtered_roster", {
    f: filters, p_prompt: prompt, p_target: target, p_difficulty: pv.difficulty === "easy" ? "normal" : "hard",
  });
  if (bErr) return err(bErr.message, 500);

  // Optionally suggest it for the browse catalogue. This is strictly additive to
  // the build: the challenge is already generated and playable by the time we get
  // here, so nothing about a submission — refusal, duplicate, or outright db
  // error — is allowed to fail the request. It reports and the player plays.
  //
  // The submission lands as `pending`. Same rule 0016 set for tier and list
  // topics: creating never publishes, and moderation gates discovery only. The
  // sheet is judged again inside mp_catalog_submit at the DEFAULT notability
  // floor, so ticking "allow deep cuts" cannot buy a listing.
  let submission: unknown = null;
  if (body.submit === true) {
    const { data: sub, error: sErr } = await db.rpc("mp_catalog_submit", {
      f: filters, p_roster_sheet_id: sheetId, p_client_id: safeClientId(body.client_id),
    });
    submission = sErr ? { ok: false, reason: "submit_failed" } : sub;
  }

  return ok({ built: true, preview: pv, filters, sheet_id: sheetId, prompt, target, submission });
}
