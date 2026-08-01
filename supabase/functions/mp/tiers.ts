import { db, ok, err, authedUserId, randomToken, tierPool, drawSet, POOL_TYPE, DAILY_ROTATION } from "./shared.ts";

// ---------------------------------------------------------------------------
// Tier-list mode (spin a set from a pool, sort into S/A/B/C/D/F, compare).
// ---------------------------------------------------------------------------
export async function loadTierTopic(body: any) {
  let q = db.from("mp_tier_topics").select("*");
  if (body.topic_id) q = q.eq("id", body.topic_id);
  else if (body.share_token) q = q.eq("share_token", body.share_token);
  else return { topic: null, error: "missing_topic_ref" };
  const { data, error } = await q.single();
  if (error || !data) return { topic: null, error: "topic_not_found" };
  return { topic: data, error: null };
}

export async function actionTierCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return err("prompt_required", 400);
  const source = ["star_players", "all_teams", "champion_teams", "notable_coaches"].includes(body.pool_source) ? body.pool_source : "star_players";
  const itemType = POOL_TYPE[source];
  const drawSize = Number.isFinite(body.draw_size) ? Math.min(16, Math.max(4, Math.floor(body.draw_size))) : 8;
  // Opt-in + moderated (migration 0016); an older cached client sending
  // `visibility` no longer publishes anything, which is the safe direction.
  const submitPublic = body.submit_public === true;
  const visibility = submitPublic ? "public" : "unlisted";
  const era = (source === "star_players" && Number.isFinite(body.era)) ? Math.floor(body.era) : null;   // decade start year; players-only
  const pool = await tierPool(source, era);
  if (pool.length < 4) return err("pool_too_small", 500);
  const itemSet = drawSet(pool, drawSize);
  const { data: topic, error: tErr } = await db.from("mp_tier_topics").insert({
    share_token: randomToken(9), prompt, item_type: itemType, pool_source: source, draw_size: drawSize,
    item_set: itemSet, pool_params: era != null ? { era } : {}, visibility,
    review_status: submitPublic ? "pending" : "unsubmitted",
    submitted_at: submitPublic ? new Date().toISOString() : null,
    creator_client_id: clientId, creator_user_id: userId, creator_label: body.label ?? "Anonymous",
  }).select("id, share_token, prompt, item_type, tiers, item_set, review_status").single();
  if (tErr) return err(tErr.message, 500);
  return ok({ topic_id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers: topic.tiers, item_set: topic.item_set, review_status: topic.review_status, is_creator: true });
}

// Creator opts an existing link-only topic into public browse — queues it for
// review; approval is out-of-band (see migration 0016).
export async function actionTierSubmit(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const isCreator = (userId && topic.creator_user_id === userId) || (clientId && topic.creator_client_id === clientId);
  if (!isCreator) return err("only_creator_can_submit", 403);
  const status = topic.review_status ?? "unsubmitted";
  if (status === "approved" || status === "pending") return ok({ review_status: status, already: true });
  if (status === "rejected") return err("submission_declined", 409);
  await db.from("mp_tier_topics").update({
    visibility: "public", review_status: "pending", submitted_at: new Date().toISOString(),
  }).eq("id", topic.id);
  return ok({ review_status: "pending" });
}

export async function actionTierReroll(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const isCreator = (userId && topic.creator_user_id === userId) || (clientId && topic.creator_client_id === clientId);
  if (!isCreator) return err("only_creator_can_reroll", 403);
  const { data: others } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id").eq("topic_id", topic.id);
  const nonCreator = (others ?? []).filter((l) => !((userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId)));
  if (nonCreator.length > 0) return err("others_already_tiered", 409);
  const itemSet = drawSet(await tierPool(topic.pool_source, (topic.pool_params as any)?.era ?? null), topic.draw_size);
  await db.from("mp_tier_topics").update({ item_set: itemSet }).eq("id", topic.id);
  await db.from("mp_tier_lists").delete().eq("topic_id", topic.id);   // set changed → clear old assignments
  return ok({ topic_id: topic.id, item_set: itemSet, tiers: topic.tiers, item_type: topic.item_type });
}

export async function actionTierOpen(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { data: lists } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id, assignments").eq("topic_id", topic.id);
  const mine = (lists ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  const isCreator = (userId && topic.creator_user_id === userId) || (clientId && topic.creator_client_id === clientId);
  return ok({
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers: topic.tiers, item_set: topic.item_set, author_count: (lists ?? []).length, is_creator: !!isCreator, review_status: topic.review_status ?? "unsubmitted" },
    your_assignments: mine?.assignments ?? {},
  });
}

export async function actionTierSave(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const validKeys = new Set((topic.item_set as any[]).map((i) => i.key));
  const validTiers = new Set(topic.tiers as string[]);
  const asg: Record<string, string> = {};
  for (const [k, v] of Object.entries(body.assignments ?? {})) { if (validKeys.has(k) && validTiers.has(v as string)) asg[k] = v as string; }
  const label = body.label ?? "Anonymous";
  const { data: rows } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id").eq("topic_id", topic.id);
  const mine = (rows ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  if (mine) {
    const patch: any = { assignments: asg, author_label: label, updated_at: new Date().toISOString() };
    if (userId && !mine.author_user_id) patch.author_user_id = userId;   // backfill so a signed-in member's board counts in crews
    await db.from("mp_tier_lists").update(patch).eq("id", mine.id);
    return ok({ list_id: mine.id, saved: true });
  }
  const { data: created, error: cErr } = await db.from("mp_tier_lists").insert({ topic_id: topic.id, author_client_id: clientId, author_user_id: userId, author_label: label, assignments: asg }).select("id").single();
  if (cErr) return err(cErr.message, 500);
  return ok({ list_id: created.id, saved: true });
}

export async function actionTierCompare(req: Request, body: any) {
  const { topic, error } = await loadTierTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { data: lists } = await db.from("mp_tier_lists").select("*").eq("topic_id", topic.id).order("created_at", { ascending: true });
  const all = lists ?? [];
  const tiers = topic.tiers as string[];
  const tierIndex = new Map(tiers.map((t, i) => [t, i]));   // S=0 (best)
  const items = topic.item_set as any[];
  const consensus = items.map((it) => {
    const dist: Record<string, number> = {}; let sum = 0, cnt = 0;
    for (const l of all) { const t = (l.assignments || {})[it.key]; if (t && tierIndex.has(t)) { dist[t] = (dist[t] || 0) + 1; sum += tierIndex.get(t)!; cnt++; } }
    let modal: string | null = null, best = 0;
    for (const t of tiers) { const c = dist[t] || 0; if (c > best) { best = c; modal = t; } }
    const avgTier = cnt ? tiers[Math.round(sum / cnt)] : null;
    return { key: it.key, label: it.label, modal_tier: modal, avg_tier: avgTier, count: cnt, distribution: dist };
  }).sort((a, b) => (a.avg_tier == null ? 99 : tierIndex.get(a.avg_tier)!) - (b.avg_tier == null ? 99 : tierIndex.get(b.avg_tier)!) || a.label.localeCompare(b.label));
  const listsOut = all.map((l) => ({ author_label: l.author_label, is_you: (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId) || false, assignments: l.assignments }));
  return ok({ topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers, item_set: items }, total_authors: all.length, consensus, lists: listsOut });
}

export async function actionTierMine(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  let q = db.from("mp_tier_lists").select("id, updated_at, author_client_id, author_user_id, topic:mp_tier_topics!inner(id, share_token, prompt, item_type, review_status, creator_client_id, creator_user_id)").order("updated_at", { ascending: false });
  q = userId ? q.eq("author_user_id", userId) : q.eq("author_client_id", clientId);
  const { data, error } = await q;
  if (error) return err(error.message, 500);
  return ok({ lists: (data ?? []).map((l: any) => ({
    topic_id: l.topic?.id, share_token: l.topic?.share_token, prompt: l.topic?.prompt, item_type: l.topic?.item_type, updated_at: l.updated_at,
    review_status: l.topic?.review_status ?? "unsubmitted",
    is_creator: !!((userId && l.topic?.creator_user_id === userId) || (clientId && l.topic?.creator_client_id === clientId)),
  })) });
}

export async function actionTierBrowse(_req: Request, _body: any) {
  const { data: topics } = await db.from("mp_tier_topics").select("id, share_token, prompt, item_type, created_at").eq("review_status", "approved").neq("creator_client_id", "daily").order("created_at", { ascending: false }).limit(60);
  const ids = (topics ?? []).map((t) => t.id);
  const { data: lists } = await db.from("mp_tier_lists").select("topic_id").in("topic_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const counts = new Map<string, number>();
  for (const l of lists ?? []) counts.set(l.topic_id, (counts.get(l.topic_id) ?? 0) + 1);
  const out = (topics ?? []).map((t) => ({ topic_id: t.id, share_token: t.share_token, prompt: t.prompt, item_type: t.item_type, author_count: counts.get(t.id) ?? 0, created_at: t.created_at }))
    .sort((a, b) => b.author_count - a.author_count || (a.created_at < b.created_at ? 1 : -1));
  return ok({ topics: out });
}

// Resolve today's daily tier topic, creating it once if needed (share_token
// uniqueness makes creation idempotent). Shared by the solo daily and crews.
export async function getOrCreateDailyTopic(): Promise<{ topic: any; date: string; dayIndex: number }> {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const token = "daily_" + date;
  const dayIndex = Math.floor(now.getTime() / 86400000);
  let { topic } = await loadTierTopic({ share_token: token });
  if (!topic) {
    // Flashback Friday: a nostalgia decade (2000s and earlier). Other days: normal rotation.
    const dow = now.getUTCDay();   // 5 = Friday (UTC)
    let prompt: string, poolSource: string, drawSizeN: number, era: number | null = null;
    if (dow === 5) {
      const decades = [1980, 1990, 2000];
      era = decades[Math.floor(dayIndex / 7) % decades.length];
      prompt = `Flashback Friday: tier these ${era}s stars`;
      poolSource = "star_players"; drawSizeN = 10;
    } else {
      const rot = DAILY_ROTATION[dayIndex % DAILY_ROTATION.length];
      prompt = rot.prompt; poolSource = rot.pool_source; drawSizeN = rot.draw_size;
    }
    const itemSet = drawSet(await tierPool(poolSource, era), drawSizeN);
    const { data: created, error: cErr } = await db.from("mp_tier_topics").insert({
      share_token: token, prompt, item_type: POOL_TYPE[poolSource], pool_source: poolSource,
      draw_size: drawSizeN, item_set: itemSet, pool_params: era != null ? { era } : {}, visibility: "public",
      review_status: "approved",   // first-party content; never enters the review queue
      creator_client_id: "daily", creator_label: "Daily",
    }).select("*").single();
    if (cErr) { const again = await loadTierTopic({ share_token: token }); topic = again.topic; }
    else topic = created;
  }
  return { topic, date, dayIndex };
}

// Daily debate: one shared tier topic per UTC date. Everyone gets the same set;
// reuses tier_save / tier_compare. No schema change needed.
export async function actionDaily(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { topic, date } = await getOrCreateDailyTopic();
  if (!topic) return err("daily_unavailable", 500);
  const { data: lists } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id, assignments").eq("topic_id", topic.id);
  const mine = (lists ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  return ok({
    date,
    flashback: /Flashback/.test(topic.prompt),
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers: topic.tiers, item_set: topic.item_set, author_count: (lists ?? []).length, is_creator: false, is_daily: true },
    your_assignments: mine?.assignments ?? {},
    done: !!mine,
  });
}

