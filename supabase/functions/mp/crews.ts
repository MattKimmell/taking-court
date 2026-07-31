import { db, ok, err, authedUserId } from "./shared.ts";
import { getOrCreateDailyTopic } from "./tiers.ts";

// -----------------------------------------------------------------------------
// Crews: account-gated private group rooms that play the Daily together.
// All crew actions require a logged-in Supabase user (authedUserId). Play for
// everyone else stays fully no-account.
// -----------------------------------------------------------------------------
export function makeCrewCode(): string {
  const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return Array.from(a, (b) => alpha[b % alpha.length]).join("");
}
export async function uniqueCrewCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const c = makeCrewCode();
    const { data } = await db.from("mp_crews").select("id").eq("code", c).maybeSingle();
    if (!data) return c;
  }
  return makeCrewCode();
}
export function dayMinus(dateStr: string, n: number): string {
  return new Date(new Date(dateStr + "T00:00:00Z").getTime() - n * 86400000).toISOString().slice(0, 10);
}
export function computeStreak(dates: Set<string>, today: string): number {
  let anchor: string | null = dates.has(today) ? today : (dates.has(dayMinus(today, 1)) ? dayMinus(today, 1) : null);
  if (!anchor) return 0;
  let streak = 0, d = anchor;
  while (dates.has(d)) { streak++; d = dayMinus(d, 1); }
  return streak;
}

export async function actionCrewCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const name = String(body.name ?? "").trim();
  if (name.length < 1 || name.length > 40) return err("invalid_name", 400);
  const display = (String(body.display_name ?? "").trim() || "Anonymous").slice(0, 40);
  const code = await uniqueCrewCode();
  const { data: crew, error: cErr } = await db.from("mp_crews").insert({ code, name, created_by: userId }).select("*").single();
  if (cErr) return err(cErr.message, 500);
  await db.from("mp_crew_members").insert({ crew_id: crew.id, user_id: userId, display_name: display, role: "owner" });
  return ok({ crew: { id: crew.id, code: crew.code, name: crew.name, member_cap: crew.member_cap, role: "owner", member_count: 1 } });
}

export async function actionCrewJoin(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!code) return err("code_required", 400);
  const display = (String(body.display_name ?? "").trim() || "Anonymous").slice(0, 40);
  const { data: crew } = await db.from("mp_crews").select("*").eq("code", code).maybeSingle();
  if (!crew) return err("crew_not_found", 404);
  const { data: members } = await db.from("mp_crew_members").select("user_id").eq("crew_id", crew.id);
  const already = (members ?? []).some((m) => m.user_id === userId);
  if (!already) {
    if ((members ?? []).length >= crew.member_cap) return err("crew_full", 403);
    const { error: mErr } = await db.from("mp_crew_members").insert({ crew_id: crew.id, user_id: userId, display_name: display, role: "member" });
    if (mErr) return err(mErr.message, 500);
  } else if (body.display_name) {
    await db.from("mp_crew_members").update({ display_name: display }).eq("crew_id", crew.id).eq("user_id", userId);
  }
  return ok({ crew: { id: crew.id, code: crew.code, name: crew.name, member_cap: crew.member_cap, role: already ? "member" : "member", member_count: (members ?? []).length + (already ? 0 : 1) } });
}

export async function actionCrewMine(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const { data: mine } = await db.from("mp_crew_members").select("crew_id, role").eq("user_id", userId);
  const ids = (mine ?? []).map((m) => m.crew_id);
  if (!ids.length) return ok({ crews: [] });
  const { data: crews } = await db.from("mp_crews").select("id, code, name").in("id", ids);
  const { data: allMembers } = await db.from("mp_crew_members").select("crew_id").in("crew_id", ids);
  const counts = new Map<string, number>();
  for (const m of allMembers ?? []) counts.set(m.crew_id, (counts.get(m.crew_id) ?? 0) + 1);
  const roleBy = new Map((mine ?? []).map((m) => [m.crew_id, m.role]));
  return ok({ crews: (crews ?? []).map((c) => ({ id: c.id, code: c.code, name: c.name, role: roleBy.get(c.id), member_count: counts.get(c.id) ?? 1 })) });
}

// The crew room for today's Daily: standings (streak + played-today), and — once
// the caller has played — everyone's boards, crew consensus, Hottest Take + badge.
export async function actionCrewDaily(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const crewId = body.crew_id;
  if (!crewId) return err("crew_required", 400);
  const { data: membership } = await db.from("mp_crew_members").select("role").eq("crew_id", crewId).eq("user_id", userId).maybeSingle();
  if (!membership) return err("not_a_member", 403);
  const { data: crew } = await db.from("mp_crews").select("id, code, name").eq("id", crewId).maybeSingle();
  if (!crew) return err("crew_not_found", 404);
  const { data: members } = await db.from("mp_crew_members").select("user_id, display_name, role").eq("crew_id", crewId);
  const memberIds = (members ?? []).map((m) => m.user_id);
  const nameBy = new Map((members ?? []).map((m) => [m.user_id, m.display_name]));
  const NONE = ["00000000-0000-0000-0000-000000000000"];

  const { topic, date } = await getOrCreateDailyTopic();
  if (!topic) return err("daily_unavailable", 500);
  const tiers = topic.tiers as string[];
  const tierIndex = new Map(tiers.map((t, i) => [t, i]));
  const items = topic.item_set as any[];

  const { data: boards } = await db.from("mp_tier_lists")
    .select("id, author_user_id, assignments, created_at")
    .eq("topic_id", topic.id).in("author_user_id", memberIds.length ? memberIds : NONE);
  const played = boards ?? [];
  const boardByUser = new Map(played.map((b) => [b.author_user_id, b]));
  const iPlayed = boardByUser.has(userId);
  const reveal = iPlayed;

  // reactions on these boards (crew-scoped), aggregated per board+emoji
  const boardIds = played.map((b) => b.id);
  const { data: reactions } = await db.from("mp_reactions").select("tier_list_id, emoji, user_id").eq("crew_id", crewId).in("tier_list_id", boardIds.length ? boardIds : NONE);
  const agg = new Map<string, Map<string, { count: number; mine: boolean }>>();
  for (const r of reactions ?? []) {
    if (!agg.has(r.tier_list_id)) agg.set(r.tier_list_id, new Map());
    const m = agg.get(r.tier_list_id)!;
    const e = m.get(r.emoji) ?? { count: 0, mine: false };
    e.count++; if (r.user_id === userId) e.mine = true; m.set(r.emoji, e);
  }

  // crew consensus (modal + avg tier) among those who played
  const consensus = items.map((it) => {
    const dist: Record<string, number> = {}; let sum = 0, cnt = 0;
    for (const b of played) { const t = (b.assignments || {})[it.key]; if (t && tierIndex.has(t)) { dist[t] = (dist[t] || 0) + 1; sum += tierIndex.get(t)!; cnt++; } }
    let modal: string | null = null, best = 0;
    for (const t of tiers) { const c = dist[t] || 0; if (c > best) { best = c; modal = t; } }
    return { key: it.key, label: it.label, modal, avg_tier: cnt ? tiers[Math.round(sum / cnt)] : null, count: cnt, distribution: dist };
  });
  const modalBy = new Map(consensus.map((c) => [c.key, c.modal]));

  // Hottest Take: biggest average divergence from the crew's modal (needs >=2 players)
  let hottest: { user_id: string; score: number } | null = null;
  if (played.length >= 2) {
    for (const b of played) {
      let sum = 0, cnt = 0;
      for (const it of items) { const t = (b.assignments || {})[it.key]; const mod = modalBy.get(it.key); if (t && mod && tierIndex.has(t)) { sum += Math.abs(tierIndex.get(t)! - tierIndex.get(mod)!); cnt++; } }
      const score = cnt ? sum / cnt : 0;
      if (cnt > 0 && (!hottest || score > hottest.score)) hottest = { user_id: b.author_user_id, score };
    }
    if (hottest && hottest.score <= 0) hottest = null;
  }

  // one rotating badge (alternates day to day)
  const dIdx = Math.floor(new Date(date + "T00:00:00Z").getTime() / 86400000);
  let badge: { type: string; label: string; user_id: string } | null = null;
  if (played.length >= 1) {
    if (dIdx % 2 === 0) {
      let first = played[0];
      for (const b of played) if (b.created_at < first.created_at) first = b;
      badge = { type: "first", label: "🎯 First on the board", user_id: first.author_user_id };
    } else {
      let bestUser: string | null = null, bestUnique = 0;
      for (const b of played) {
        let uniq = 0;
        for (const it of items) { const t = (b.assignments || {})[it.key]; if (!t) continue; const shared = played.some((o) => o !== b && (o.assignments || {})[it.key] === t); if (!shared) uniq++; }
        if (uniq > bestUnique) { bestUnique = uniq; bestUser = b.author_user_id; }
      }
      if (bestUser) badge = { type: "wildcard", label: "🃏 Wildcard", user_id: bestUser };
    }
  }

  // streaks from each member's daily-play history
  const { data: dailyRows } = await db.from("mp_tier_lists").select("author_user_id, t:mp_tier_topics!inner(share_token)").in("author_user_id", memberIds.length ? memberIds : NONE);
  const streakDates = new Map<string, Set<string>>();
  for (const row of (dailyRows ?? []) as any[]) {
    const st = row.t?.share_token as string | undefined;
    if (st && st.startsWith("daily_")) {
      if (!streakDates.has(row.author_user_id)) streakDates.set(row.author_user_id, new Set());
      streakDates.get(row.author_user_id)!.add(st.slice(6));
    }
  }

  const memberOut = (members ?? []).map((m) => {
    const board = boardByUser.get(m.user_id);
    return {
      user_id: m.user_id,
      display_name: m.display_name,
      role: m.role,
      is_you: m.user_id === userId,
      played_today: !!board,
      streak: computeStreak(streakDates.get(m.user_id) ?? new Set(), date),
      board_id: board?.id ?? null,
      assignments: (reveal && board) ? board.assignments : null,
      reactions: board ? Array.from((agg.get(board.id) ?? new Map()).entries()).map(([emoji, v]) => ({ emoji, count: v.count, mine: v.mine })) : [],
    };
  }).sort((a, b) => b.streak - a.streak || a.display_name.localeCompare(b.display_name));

  return ok({
    crew: { id: crew.id, code: crew.code, name: crew.name, member_count: (members ?? []).length },
    date,
    topic: { id: topic.id, share_token: topic.share_token, prompt: topic.prompt, item_type: topic.item_type, tiers, item_set: items, is_daily: true },
    i_played: iPlayed,
    your_assignments: boardByUser.get(userId)?.assignments ?? {},
    players_today: played.length,
    consensus: reveal ? consensus : null,
    hottest_take: reveal && hottest ? { user_id: hottest.user_id, display_name: nameBy.get(hottest.user_id) } : null,
    badge: reveal && badge ? { type: badge.type, label: badge.label, user_id: badge.user_id, display_name: nameBy.get(badge.user_id) } : null,
    members: memberOut,
  });
}

export async function actionCrewReact(req: Request, body: any) {
  const userId = authedUserId(req);
  if (!userId) return err("sign_in_required", 401);
  const crewId = body.crew_id, listId = body.tier_list_id, emoji = String(body.emoji ?? "").slice(0, 8);
  if (!crewId || !listId || !emoji) return err("bad_request", 400);
  const { data: mem } = await db.from("mp_crew_members").select("user_id").eq("crew_id", crewId).eq("user_id", userId).maybeSingle();
  if (!mem) return err("not_a_member", 403);
  const { data: existing } = await db.from("mp_reactions").select("id").eq("crew_id", crewId).eq("tier_list_id", listId).eq("user_id", userId).eq("emoji", emoji).maybeSingle();
  if (existing) { await db.from("mp_reactions").delete().eq("id", existing.id); return ok({ toggled: "off" }); }
  const { error: iErr } = await db.from("mp_reactions").insert({ crew_id: crewId, tier_list_id: listId, user_id: userId, emoji });
  if (iErr) return err(iErr.message, 500);
  return ok({ toggled: "on" });
}

