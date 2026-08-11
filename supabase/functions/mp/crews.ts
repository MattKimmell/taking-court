import { db, ok, err, authedUserId, computeStreak } from "./shared.ts";
import { getOrCreateCourtDay } from "./court.ts";
import {
  crewCanRevealTakes,
  crewChallengeOnlySocialNote,
  crewDayMatchesSolo,
  crewHottestTakeEligible,
  crewMemberCourtFlags,
  takeConsensus,
  takeHotScore,
} from "./court_contract.js";

// -----------------------------------------------------------------------------
// Crews: account-gated private group rooms that play Daily Court together.
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

async function courtDatesForUsers(userIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const id of userIds) out.set(id, new Set());
  if (!userIds.length) return out;
  const NONE = ["00000000-0000-0000-0000-000000000000"];

  const { data: locks } = await db.from("mp_court_take_locks")
    .select("author_user_id, day_id")
    .in("author_user_id", userIds);
  const dayIds = [...new Set((locks ?? []).map((l: any) => l.day_id).filter(Boolean))];
  const dayById = new Map<string, string>();
  if (dayIds.length) {
    const { data: days } = await db.from("mp_court_days").select("id, day").in("id", dayIds);
    for (const d of days ?? []) dayById.set(d.id, String(d.day));
  }
  for (const lock of locks ?? []) {
    const day = dayById.get(lock.day_id);
    if (day && lock.author_user_id) out.get(lock.author_user_id)?.add(day);
  }

  const { data: courtDays } = await db.from("mp_court_days").select("day, challenge_definition");
  const byChallenge = new Map<string, string>();
  for (const day of courtDays ?? []) {
    const id = (day.challenge_definition as any)?.challenge_id;
    if (id) byChallenge.set(id, String(day.day));
  }
  if (byChallenge.size) {
    const { data: attempts } = await db.from("mp_attempts")
      .select("challenge_id, player_user_id, status")
      .in("challenge_id", [...byChallenge.keys()])
      .in("player_user_id", userIds.length ? userIds : NONE)
      .eq("status", "completed");
    for (const attempt of attempts ?? []) {
      const day = byChallenge.get(attempt.challenge_id);
      if (day && attempt.player_user_id) out.get(attempt.player_user_id)?.add(day);
    }
  }
  return out;
}

// Crew room for today's Daily Court: same day identity as solo, beat flags,
// Court streaks, Take lock-to-reveal, hottest take among locked Takes.
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

  const courtDay = await getOrCreateCourtDay();
  if (!courtDay) return err("court_day_unavailable", 500);
  const date = courtDay.day;
  const items = (courtDay.house_take?.items ?? []) as any[];
  const challengeId = courtDay.challenge_definition?.challenge_id as string | undefined;

  const { data: locks } = await db.from("mp_court_take_locks")
    .select("id, author_user_id, author_label, answers, created_at")
    .eq("day_id", courtDay.id)
    .in("author_user_id", memberIds.length ? memberIds : NONE);
  const lockByUser = new Map((locks ?? []).filter((l: any) => l.author_user_id).map((l: any) => [l.author_user_id, l]));

  let challengeDoneUsers = new Set<string>();
  let challengeAttemptByUser = new Map<string, any>();
  if (challengeId) {
    const { data: attempts } = await db.from("mp_attempts")
      .select("id, player_user_id, status, correct_count, strikes")
      .eq("challenge_id", challengeId)
      .in("player_user_id", memberIds.length ? memberIds : NONE);
    for (const a of attempts ?? []) {
      if (!a.player_user_id) continue;
      challengeAttemptByUser.set(a.player_user_id, a);
      if (a.status === "completed") challengeDoneUsers.add(a.player_user_id);
    }
  }

  const viewerLock = lockByUser.get(userId);
  const iTakeDone = !!viewerLock;
  const revealTakes = crewCanRevealTakes(iTakeDone);
  const crewLocks = [...lockByUser.values()];
  const consensus = takeConsensus(items, crewLocks as any[]);
  const consensus_gate = { have: crewLocks.length, honest_empty: crewLocks.length <= 1 };

  let hottest: { user_id: string; score: number } | null = null;
  if (crewHottestTakeEligible({ revealTakes, takeLockCount: crewLocks.length })) {
    for (const lock of crewLocks) {
      const score = takeHotScore(items, lock.answers, consensus);
      if (!hottest || score > hottest.score) hottest = { user_id: lock.author_user_id, score };
    }
    if (hottest && hottest.score <= 0) hottest = null;
  }

  let badge: { type: string; label: string; user_id: string } | null = null;
  if (crewLocks.length >= 1) {
    const dIdx = Math.floor(new Date(date + "T00:00:00Z").getTime() / 86400000);
    if (dIdx % 2 === 0) {
      let first = crewLocks[0];
      for (const b of crewLocks) if (b.created_at < first.created_at) first = b;
      badge = { type: "first", label: "🎯 First Take locked", user_id: first.author_user_id };
    } else if (hottest) {
      badge = { type: "hot", label: "🌶️ Hottest Take", user_id: hottest.user_id };
    }
  }

  const streakDates = await courtDatesForUsers(memberIds);

  const memberOut = (members ?? []).map((m) => {
    const lock = lockByUser.get(m.user_id);
    const flags = crewMemberCourtFlags({
      takeDone: !!lock,
      challengeDone: challengeDoneUsers.has(m.user_id),
    });
    const attempt = challengeAttemptByUser.get(m.user_id);
    return {
      user_id: m.user_id,
      display_name: m.display_name,
      role: m.role,
      is_you: m.user_id === userId,
      ...flags,
      streak: computeStreak(streakDates.get(m.user_id) ?? new Set(), date),
      take_lock_id: lock?.id ?? null,
      answers: (revealTakes && lock) ? lock.answers : null,
      challenge_attempt: attempt ? {
        status: attempt.status,
        correct_count: attempt.correct_count ?? 0,
        strikes: attempt.strikes ?? 0,
      } : null,
      // Tier reactions do not apply to Court Takes; keep empty for client compat.
      // Social in this slice: hottest Take + beat flags (see crewChallengeOnlySocialNote).
      reactions: [],
      board_id: null,
      assignments: null,
    };
  }).sort((a, b) => b.streak - a.streak || a.display_name.localeCompare(b.display_name));

  const playersToday = memberOut.filter((m) => m.played_today).length;
  const iPlayed = !!memberOut.find((m) => m.is_you)?.played_today;
  const challengeOnlyCount = memberOut.filter((m) => m.challenge_done && !m.take_done).length;
  const challenge_only_note = crewChallengeOnlySocialNote({
    challengeOnlyCount,
    takeLockCount: crewLocks.length,
  });

  // Same day identity as solo Daily Court (court_<date>).
  const dayOut = { id: courtDay.id, share_token: courtDay.share_token };
  if (!crewDayMatchesSolo({
    crewDate: date,
    soloDate: courtDay.day,
    crewShareToken: dayOut.share_token,
    soloShareToken: courtDay.share_token,
  })) {
    return err("crew_day_mismatch", 500);
  }

  return ok({
    crew: { id: crew.id, code: crew.code, name: crew.name, member_count: (members ?? []).length },
    date,
    day: dayOut,
    take: courtDay.house_take,
    challenge: {
      prompt: courtDay.challenge_definition?.prompt ?? null,
      axis: courtDay.challenge_definition?.axis ?? null,
      target: courtDay.challenge_definition?.target ?? null,
    },
    // Back-compat shape: older clients read topic.prompt
    topic: {
      id: courtDay.id,
      share_token: courtDay.share_token,
      prompt: courtDay.house_take?.title ?? "Daily Court",
      is_daily: true,
      is_court: true,
    },
    i_played: iPlayed,
    i_take_done: iTakeDone,
    reveal_takes: revealTakes,
    your_answers: viewerLock?.answers ?? {},
    players_today: playersToday,
    challenge_only_note,
    consensus: revealTakes ? consensus : null,
    consensus_gate,
    hottest_take: revealTakes && hottest ? { user_id: hottest.user_id, display_name: nameBy.get(hottest.user_id) } : null,
    badge: revealTakes && badge ? { type: badge.type, label: badge.label, user_id: badge.user_id, display_name: nameBy.get(badge.user_id) } : null,
    members: memberOut,
  });
}

// Legacy tier-board reactions still accepted if a tier_list_id is sent.
// Court Take reactions are not in this slice (no take_lock reaction column).
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
