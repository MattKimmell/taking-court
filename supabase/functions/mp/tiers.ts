import { db, ok, err, authedUserId, randomToken, tierPool, drawSet, POOL_TYPE, DAILY_ROTATION, ownerFilter, creatorFilter, safeClientId, consensusFor, scoreBoard, minBoardsFor, computeStreak } from "./shared.ts";

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
  // Structural, and BEFORE the identity check on purpose. A curated set is the
  // whole point of a theme, and a reroll both redraws the set and deletes every
  // board on the topic — for a globally-pooled theme that wipes the consensus.
  // The identity check below cannot carry this: client_id is read raw from the
  // body, so {client_id:"daily"} used to match the Daily's creator_client_id and
  // let anyone redraw the Daily before the first player of the day saved.
  if ((topic.kind ?? "user") !== "user") return err("cannot_reroll_curated", 403);
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  const isCreator = (userId && topic.creator_user_id === userId) || (clientId && topic.creator_client_id === clientId);
  if (!isCreator) return err("only_creator_can_reroll", 403);
  const { data: others } = await db.from("mp_tier_lists").select("id, author_client_id, author_user_id").eq("topic_id", topic.id);
  const nonCreator = (others ?? []).filter((l) => !((userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId)));
  if (nonCreator.length > 0) return err("others_already_tiered", 409);
  const pool = await tierPool(topic.pool_source, (topic.pool_params as any)?.era ?? null);
  if (pool.length < 4) return err("pool_too_small", 500);   // mirrors actionTierCreate; never delete boards for a short draw
  const itemSet = drawSet(pool, topic.draw_size);
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
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers: topic.tiers, item_set: topic.item_set, author_count: (lists ?? []).length, is_creator: !!isCreator, review_status: topic.review_status ?? "unsubmitted", kind: topic.kind ?? "user", invite: topic.invite ?? null },
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
  // Saving a daily board is what advances the streak, so hand the new value back
  // instead of making the client re-fetch or guess. Computed AFTER the write, so
  // today is already counted.
  const dailyDate = (topic.kind === "daily")
    ? (/^daily_(\d{4}-\d{2}-\d{2})$/.exec(topic.share_token ?? "")?.[1] ?? null)
    : null;
  const withStreak = async (extra: Record<string, unknown>) =>
    dailyDate ? { ...extra, streak: await soloStreak(userId, clientId, dailyDate) } : extra;

  if (mine) {
    const patch: any = { assignments: asg, author_label: label, updated_at: new Date().toISOString() };
    if (userId && !mine.author_user_id) patch.author_user_id = userId;   // backfill so a signed-in member's board counts in crews
    await db.from("mp_tier_lists").update(patch).eq("id", mine.id);
    return ok(await withStreak({ list_id: mine.id, saved: true }));
  }
  const { data: created, error: cErr } = await db.from("mp_tier_lists").insert({ topic_id: topic.id, author_client_id: clientId, author_user_id: userId, author_label: label, assignments: asg }).select("id").single();
  if (cErr) return err(cErr.message, 500);
  return ok(await withStreak({ list_id: created.id, saved: true }));
}

// Curated themes: the featured one is returned separately because it gets a
// hero slot. Everyone playing a theme tiers the identical set, so author_count
// is both social proof and the score-gate countdown.
export async function actionTierThemes() {
  const { data: themes } = await db.from("mp_tier_themes")
    .select("slug, prompt, blurb, item_type, featured, sort_order")
    .eq("status", "approved").order("sort_order", { ascending: true });
  const rows = themes ?? [];
  if (!rows.length) return ok({ featured: null, themes: [] });

  const tokens = rows.map((t) => "theme_" + t.slug);
  const { data: topics } = await db.from("mp_tier_topics")
    .select("id, share_token, kind").in("share_token", tokens);
  const idByToken = new Map((topics ?? []).map((t) => [t.share_token, t.id]));

  const { data: boards } = await db.from("mp_tier_lists")
    .select("topic_id").in("topic_id", Array.from(idByToken.values()));
  const counts = new Map<string, number>();
  for (const b of boards ?? []) counts.set(b.topic_id, (counts.get(b.topic_id) ?? 0) + 1);

  const need = minBoardsFor("theme");
  const out = rows.map((t) => {
    const token = "theme_" + t.slug;
    const have = counts.get(idByToken.get(token) ?? "") ?? 0;
    return {
      slug: t.slug, prompt: t.prompt, blurb: t.blurb, item_type: t.item_type,
      share_token: token, author_count: have,
      score_gate: { have, need, unlocked: have >= need },
    };
  });
  return ok({
    featured: out.find((_, i) => rows[i].featured) ?? null,
    themes: out.filter((_, i) => !rows[i].featured),
  });
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
  // Sort stays here, not in consensusFor: it's presentation for the consensus
  // column, and crews.ts / the client's share grid must keep their own order.
  const consensus = consensusFor(items, all, tiers)
    .sort((a, b) => (a.avg_tier == null ? 99 : tierIndex.get(a.avg_tier)!) - (b.avg_tier == null ? 99 : tierIndex.get(b.avg_tier)!) || a.label.localeCompare(b.label));
  const listsOut = all.map((l) => ({ author_label: l.author_label, is_you: (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId) || false, assignments: l.assignments }));

  // Guess-the-consensus. Gated so a "score" is never computed against a room
  // too small to be one; below the gate the client shows a share prompt.
  const need = minBoardsFor(topic.kind);
  const unlocked = all.length >= need;
  const mine = all.find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  const yourScore = (unlocked && mine) ? scoreBoard(mine.assignments, consensus, tiers) : null;

  return ok({
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers, item_set: items, kind: topic.kind ?? "user", invite: topic.invite ?? null },
    total_authors: all.length, consensus, lists: listsOut,
    score_gate: { have: all.length, need, unlocked },
    your_score: yourScore,
  });
}

export async function actionTierMine(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const owner = ownerFilter(userId, clientId);
  if (!owner) return err("identity_required", 400);
  const { data, error } = await db.from("mp_tier_lists")
    .select("id, updated_at, assignments, author_client_id, author_user_id, topic:mp_tier_topics!inner(id, share_token, prompt, item_type, review_status, creator_client_id, creator_user_id)")
    .or(owner).order("updated_at", { ascending: false });
  if (error) return err(error.message, 500);

  const rows = (data ?? []).map((l: any) => ({
    topic_id: l.topic?.id, share_token: l.topic?.share_token, prompt: l.topic?.prompt, item_type: l.topic?.item_type, updated_at: l.updated_at,
    item_count: Object.keys(l.assignments ?? {}).length,
    review_status: l.topic?.review_status ?? "unsubmitted",
    is_creator: !!((userId && l.topic?.creator_user_id === userId) || (clientId && l.topic?.creator_client_id === clientId)),
    started: true,
  }));

  // Topics you created but never saved a board for have no mp_tier_lists row,
  // so the join above can't see them and the share token is gone forever.
  const creator = creatorFilter(userId, clientId);
  if (creator) {
    const seen = new Set(rows.map((r) => r.topic_id));
    const { data: mineTopics } = await db.from("mp_tier_topics")
      .select("id, share_token, prompt, item_type, review_status, created_at")
      .or(creator).eq("kind", "user").order("created_at", { ascending: false });
    for (const t of mineTopics ?? []) {
      if (seen.has(t.id)) continue;
      rows.push({
        topic_id: t.id, share_token: t.share_token, prompt: t.prompt, item_type: t.item_type,
        updated_at: t.created_at, item_count: 0,
        review_status: t.review_status ?? "unsubmitted", is_creator: true, started: false,
      });
    }
    rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }
  return ok({ lists: rows });
}

export async function actionTierBrowse(_req: Request, _body: any) {
  // kind='user' rather than "not daily": themes are approved and not daily, so
  // the old filter would have leaked every theme into Browse alongside
  // user-made topics.
  const { data: topics } = await db.from("mp_tier_topics").select("id, share_token, prompt, item_type, created_at").eq("review_status", "approved").eq("kind", "user").order("created_at", { ascending: false }).limit(60);
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
    // Scheduled theme for today, if one is booked. The set is COPIED, never
    // pointed at: the Daily's identity is its daily_<date> token, and sharing a
    // theme's topic instead would mean anyone who played that theme already
    // reads as done, with no streak bump and broken crew streak parsing.
    let row: Record<string, unknown> | null = null;
    const { data: sched } = await db.from("mp_daily_schedule")
      .select("theme_slug").eq("day", date).maybeSingle();
    if (sched?.theme_slug) {
      const { data: th } = await db.from("mp_tier_themes")
        .select("id, prompt, invite, item_type, item_set, status")
        .eq("slug", sched.theme_slug).maybeSingle();
      if (th && th.status === "approved") {
        row = {
          share_token: token, prompt: th.prompt, item_type: th.item_type,
          pool_source: "curated", draw_size: (th.item_set as any[]).length,
          item_set: th.item_set, pool_params: {}, visibility: "public",
          review_status: "approved", kind: "daily", theme_id: th.id, invite: th.invite,
          creator_client_id: "daily", creator_label: "Daily",
        };
      }
    }

    if (!row) {
      // Unscheduled — the common case, and byte-for-byte the previous behaviour.
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
      row = {
        share_token: token, prompt, item_type: POOL_TYPE[poolSource], pool_source: poolSource,
        draw_size: drawSizeN, item_set: itemSet, pool_params: era != null ? { era } : {}, visibility: "public",
        review_status: "approved",   // first-party content; never enters the review queue
        kind: "daily", creator_client_id: "daily", creator_label: "Daily",
      };
    }

    const { data: created, error: cErr } = await db.from("mp_tier_topics").insert(row).select("*").single();
    if (cErr) { const again = await loadTierTopic({ share_token: token }); topic = again.topic; }
    else topic = created;
  }
  return { topic, date, dayIndex };
}

// Daily debate: one shared tier topic per UTC date. Everyone gets the same set;
// reuses tier_save / tier_compare. No schema change needed.
// Solo daily streak, derived from play history rather than stored.
//
// The client kept this in localStorage, which meant it died on a cache clear and
// the server could never assert it — and you cannot send "your streak is about
// to break" from a server that does not know the streak. Deriving it means there
// is nothing to migrate, nothing to keep in sync, and no way for a client to
// inflate it.
//
// Daily topics carry their date in the share_token (daily_YYYY-MM-DD), which is
// the same handle crew streaks parse, so both read the same history.
export async function soloStreak(userId: string | null, clientId: string | null, today: string) {
  const empty = { current: 0, last_played: null as string | null, played_today: false };
  const filter = ownerFilter(userId, clientId);
  if (!filter) return empty;

  const { data: dailies } = await db.from("mp_tier_topics")
    .select("id, share_token").eq("kind", "daily");
  if (!dailies?.length) return empty;

  const dateById = new Map<string, string>();
  for (const d of dailies) {
    const m = /^daily_(\d{4}-\d{2}-\d{2})$/.exec(d.share_token ?? "");
    if (m) dateById.set(d.id, m[1]);
  }
  if (!dateById.size) return empty;

  const { data: mine } = await db.from("mp_tier_lists")
    .select("topic_id").in("topic_id", [...dateById.keys()]).or(filter);

  const dates = new Set<string>();
  for (const l of mine ?? []) { const d = dateById.get(l.topic_id); if (d) dates.add(d); }
  if (!dates.size) return empty;

  const sorted = [...dates].sort();
  return {
    current: computeStreak(dates, today),
    last_played: sorted[sorted.length - 1],
    played_today: dates.has(today),
  };
}

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
    streak: await soloStreak(userId, clientId, date),
  });
}

