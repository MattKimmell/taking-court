import { db, ok, err, authedUserId, randomToken, safeClientId } from "./shared.ts";
import { normalizeTakeAnswers, playerTakeLockOut, takeConsensus, validateTakeItems } from "./court_contract.js";

async function loadTake(body: any) {
  let q = db.from("mp_take_topics").select("*");
  if (body.take_id) q = q.eq("id", body.take_id);
  else if (body.share_token) q = q.eq("share_token", String(body.share_token));
  else return { take: null, error: "missing_take_ref" };
  const { data, error } = await q.single();
  if (error || !data) return { take: null, error: "take_not_found" };
  return { take: data, error: null };
}

async function takeLocks(takeId: string) {
  const { data } = await db.from("mp_take_locks")
    .select("id, author_client_id, author_user_id, author_label, answers, created_at, updated_at")
    .eq("take_id", takeId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

function takeTopicOut(take: any, locks: any[], userId: string | null, clientId: string | null) {
  return {
    id: take.id,
    share_token: take.share_token,
    title: take.title,
    items: take.items,
    visibility: take.visibility ?? "unlisted",
    review_status: take.review_status ?? "unsubmitted",
    is_creator: !!((userId && take.creator_user_id === userId) || (clientId && take.creator_client_id === clientId)),
    author_count: locks.length,
  };
}

function takeCompareOut(take: any, locks: any[], mine: any | null) {
  return {
    topic: {
      id: take.id,
      share_token: take.share_token,
      title: take.title,
      author_count: locks.length,
    },
    locked: !!mine,
    your_answers: mine?.answers ?? null,
    consensus: takeConsensus(take.items, locks as any[]),
    consensus_gate: { have: locks.length, honest_empty: locks.length <= 1 },
  };
}

function findMine(locks: any[], userId: string | null, clientId: string | null) {
  return locks.find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId)) ?? null;
}

export async function actionTakeCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  if (!userId && !clientId) return err("identity_required", 400);
  const title = String(body.title ?? "").trim().slice(0, 120);
  if (!title) return err("title_required", 400);
  const items = Array.isArray(body.items) ? body.items : [];
  const structuralError = validateTakeItems(items);
  if (structuralError) return err(structuralError, 400);

  const { data: take, error } = await db.from("mp_take_topics").insert({
    share_token: randomToken(9),
    title,
    items,
    visibility: "unlisted",
    review_status: "unsubmitted",
    creator_client_id: clientId,
    creator_user_id: userId,
    creator_label: String(body.label ?? "Anonymous").slice(0, 40),
  }).select("*").single();
  if (error || !take) return err(error?.message ?? "take_create_failed", 500);
  return ok({ topic: takeTopicOut(take, [], userId, clientId) });
}

export async function actionTakeOpen(req: Request, body: any) {
  const { take, error } = await loadTake(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  const locks = await takeLocks(take.id);
  const mine = findMine(locks, userId, clientId);
  return ok({
    topic: takeTopicOut(take, locks, userId, clientId),
    your_answers: mine?.answers ?? {},
    locked: !!mine,
    compare: mine ? takeCompareOut(take, locks, mine) : null,
  });
}

export async function actionTakeLock(req: Request, body: any) {
  const { take, error } = await loadTake(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  if (!userId && !clientId) return err("identity_required", 400);
  const normalized = normalizeTakeAnswers(take.items, body.answers);
  if (normalized.error) return err(normalized.error, 400);
  const label = String(body.label ?? "Anonymous").slice(0, 40);
  const locks = await takeLocks(take.id);
  const mine = findMine(locks, userId, clientId);
  const patch = {
    answers: normalized.answers,
    author_label: label,
    updated_at: new Date().toISOString(),
    ...(userId ? { author_user_id: userId } : {}),
  };

  if (mine) {
    await db.from("mp_take_locks").update(patch).eq("id", mine.id);
  } else {
    const { error: insertErr } = await db.from("mp_take_locks").insert({
      take_id: take.id,
      author_client_id: clientId,
      author_user_id: userId,
      author_label: label,
      answers: normalized.answers,
    });
    if (insertErr) {
      const raced = await takeLocks(take.id);
      const racedMine = findMine(raced, userId, clientId);
      if (!racedMine) return err(insertErr.message, 500);
      await db.from("mp_take_locks").update(patch).eq("id", racedMine.id);
    }
  }

  const after = await takeLocks(take.id);
  const afterMine = findMine(after, userId, clientId);
  return ok(playerTakeLockOut(
    takeCompareOut(take, after, afterMine),
    takeTopicOut(take, after, userId, clientId),
  ));
}

export async function actionTakeCompare(req: Request, body: any) {
  const { take, error } = await loadTake(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  const locks = await takeLocks(take.id);
  const mine = findMine(locks, userId, clientId);
  if (!mine) return err("lock_take_first", 403);
  return ok(takeCompareOut(take, locks, mine));
}
