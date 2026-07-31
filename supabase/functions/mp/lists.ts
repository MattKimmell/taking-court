import { db, ok, err, authedUserId, normalize, randomToken } from "./shared.ts";

// ---------------------------------------------------------------------------
// Subjective lists ("make your own list" — no correct answer).
// ---------------------------------------------------------------------------
export function cleanItems(raw: any, max: number) {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const it of Array.isArray(raw) ? raw : []) {
    const label = String(it?.label ?? "").trim();
    if (!label) continue;
    const key = normalize(label);
    if (!key || seen.has(key)) continue;           // dedupe within a list
    seen.add(key);
    out.push({
      rank: out.length + 1, label, key,
      note: it?.note ? String(it.note).slice(0, 240) : null,
      player_key: it?.player_key ?? null,
    });
    if (out.length >= max) break;
  }
  return out;
}

export async function loadTopic(body: any) {
  let q = db.from("mp_list_topics").select("*");
  if (body.topic_id) q = q.eq("id", body.topic_id);
  else if (body.share_token) q = q.eq("share_token", body.share_token);
  else return { topic: null, error: "missing_topic_ref" };
  const { data, error } = await q.single();
  if (error || !data) return { topic: null, error: "topic_not_found" };
  return { topic: data, error: null };
}

export async function actionListCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return err("prompt_required", 400);
  const ranked = body.ranked !== false;
  const maxItems = Number.isFinite(body.max_items) ? Math.min(25, Math.max(1, Math.floor(body.max_items))) : 10;
  const entryType = ["player", "team", "coach", "moment"].includes(body.entry_type) ? body.entry_type : "player";
  const visibility = body.visibility === "unlisted" ? "unlisted" : "public";
  const { data: topic, error: tErr } = await db.from("mp_list_topics").insert({
    share_token: randomToken(9), prompt, ranked, max_items: maxItems, entry_type: entryType, visibility,
    creator_client_id: clientId, creator_user_id: userId, creator_label: body.label ?? "Anonymous",
  }).select("id, share_token, prompt, ranked, max_items, entry_type, visibility").single();
  if (tErr) return err(tErr.message, 500);

  let listId: string | null = null;
  if (Array.isArray(body.items) && body.items.length) {
    const { data: list } = await db.from("mp_lists").insert({
      topic_id: topic.id, author_client_id: clientId, author_user_id: userId,
      author_label: body.label ?? "Anonymous", items: cleanItems(body.items, maxItems),
    }).select("id").single();
    listId = list?.id ?? null;
  }
  return ok({ topic_id: topic.id, share_token: topic.share_token, prompt: topic.prompt, ranked: topic.ranked, max_items: topic.max_items, entry_type: topic.entry_type, visibility: topic.visibility, list_id: listId });
}

export async function actionListSave(req: Request, body: any) {
  const { topic, error: tErr } = await loadTopic(body);
  if (tErr) return err(tErr, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  const items = cleanItems(body.items, topic.max_items);
  const label = body.label ?? "Anonymous";

  const { data: rows } = await db.from("mp_lists").select("id, author_client_id, author_user_id").eq("topic_id", topic.id);
  const mine = (rows ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  if (mine) {
    await db.from("mp_lists").update({ items, author_label: label, updated_at: new Date().toISOString() }).eq("id", mine.id);
    return ok({ list_id: mine.id, item_count: items.length, saved: true });
  }
  const { data: created, error: cErr } = await db.from("mp_lists").insert({
    topic_id: topic.id, author_client_id: clientId, author_user_id: userId, author_label: label, items,
  }).select("id").single();
  if (cErr) return err(cErr.message, 500);
  return ok({ list_id: created.id, item_count: items.length, saved: true });
}

export async function actionListOpen(req: Request, body: any) {
  const { topic, error } = await loadTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { data: lists } = await db.from("mp_lists").select("id, author_client_id, author_user_id, items, author_label").eq("topic_id", topic.id);
  const mine = (lists ?? []).find((l) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  return ok({
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, ranked: topic.ranked, max_items: topic.max_items, entry_type: topic.entry_type ?? "player", visibility: topic.visibility ?? "public", author_count: (lists ?? []).length },
    your_list: mine ? { id: mine.id, items: mine.items, author_label: mine.author_label } : null,
  });
}

export async function actionListCompare(req: Request, body: any) {
  const { topic, error } = await loadTopic(body);
  if (error) return err(error, 404);
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  const { data: lists } = await db.from("mp_lists").select("*").eq("topic_id", topic.id).order("created_at", { ascending: true });
  const all = lists ?? [];
  const total = all.length;

  const agg = new Map<string, any>();
  for (const l of all) {
    for (const it of (l.items ?? [])) {
      const k = it.key || normalize(it.label);
      if (!k) continue;
      let e = agg.get(k);
      if (!e) { e = { label: it.label, count: 0, rankSum: 0, rankedCount: 0, authors: [] }; agg.set(k, e); }
      e.count++; e.authors.push(l.author_label);
      if (typeof it.rank === "number") { e.rankSum += it.rank; e.rankedCount++; }
    }
  }
  const consensus = Array.from(agg.values()).map((e) => ({
    label: e.label, count: e.count, pct: total ? Math.round(100 * e.count / total) : 0,
    avg_rank: e.rankedCount ? +(e.rankSum / e.rankedCount).toFixed(1) : null, authors: e.authors,
  })).sort((a, b) => b.count - a.count || ((a.avg_rank ?? 99) - (b.avg_rank ?? 99)) || a.label.localeCompare(b.label));

  const listsOut = all.map((l) => ({
    list_id: l.id, author_label: l.author_label,
    is_you: (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId) || false,
    items: (l.items ?? []).map((it: any) => ({ rank: it.rank, label: it.label, note: it.note ?? null })),
    updated_at: l.updated_at,
  }));
  return ok({ topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, ranked: topic.ranked, entry_type: topic.entry_type ?? "player" }, total_authors: total, lists: listsOut, consensus });
}

export async function actionListMine(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!userId && !clientId) return err("identity_required", 400);
  let q = db.from("mp_lists").select("id, items, updated_at, topic:mp_list_topics!inner(id, share_token, prompt, ranked, max_items, entry_type)").order("updated_at", { ascending: false });
  q = userId ? q.eq("author_user_id", userId) : q.eq("author_client_id", clientId);
  const { data, error } = await q;
  if (error) return err(error.message, 500);
  return ok({
    lists: (data ?? []).map((l: any) => ({
      list_id: l.id, item_count: (l.items ?? []).length, updated_at: l.updated_at,
      topic_id: l.topic?.id, share_token: l.topic?.share_token, prompt: l.topic?.prompt, ranked: l.topic?.ranked, max_items: l.topic?.max_items, entry_type: l.topic?.entry_type ?? "player",
    })),
  });
}

// Public discovery: recent public topics, ranked by how many people have listed.
export async function actionListBrowse(_req: Request, _body: any) {
  const { data: topics } = await db.from("mp_list_topics")
    .select("id, share_token, prompt, ranked, entry_type, created_at")
    .eq("visibility", "public")
    .order("created_at", { ascending: false })
    .limit(60);
  const ids = (topics ?? []).map((t) => t.id);
  const { data: lists } = await db.from("mp_lists").select("topic_id")
    .in("topic_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
  const counts = new Map<string, number>();
  for (const l of lists ?? []) counts.set(l.topic_id, (counts.get(l.topic_id) ?? 0) + 1);
  const out = (topics ?? []).map((t) => ({
    topic_id: t.id, share_token: t.share_token, prompt: t.prompt, ranked: t.ranked,
    entry_type: t.entry_type ?? "player", author_count: counts.get(t.id) ?? 0, created_at: t.created_at,
  })).sort((a, b) => b.author_count - a.author_count || (a.created_at < b.created_at ? 1 : -1));
  return ok({ topics: out });
}

