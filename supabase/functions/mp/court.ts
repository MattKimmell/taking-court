import { db, ok, err, authedUserId, ownerFilter, safeClientId, computeStreak } from "./shared.ts";
import { courtDate, courtToken, houseTakeForDate, normalizeTakeAnswers, takeConsensus, validateTakeItems } from "./court_contract.js";

type CourtDay = {
  id: string;
  day: string;
  share_token: string;
  house_take: {
    id: string;
    title: string;
    items: unknown[];
  };
};

function dayFromBody(body: any): string {
  const d = String(body.day ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : courtDate();
}

async function getOrCreateCourtDay(day = courtDate()): Promise<CourtDay | null> {
  const token = courtToken(day);
  const existing = await db.from("mp_court_days").select("*").eq("day", day).maybeSingle();
  if (existing.data) return existing.data as CourtDay;

  const houseTake = houseTakeForDate(day);
  const structuralError = validateTakeItems(houseTake.items);
  if (structuralError) throw new Error(`invalid_house_take: ${structuralError}`);

  const row = {
    day,
    share_token: token,
    house_take: houseTake,
    status: "published",
  };
  const created = await db.from("mp_court_days").insert(row).select("*").single();
  if (created.data) return created.data as CourtDay;

  // A concurrent first resolve can win the unique constraint race.
  const again = await db.from("mp_court_days").select("*").eq("day", day).maybeSingle();
  return (again.data as CourtDay | null) ?? null;
}

async function courtStreak(userId: string | null, clientId: string | null, today: string) {
  const empty = { current: 0, last_played: null as string | null, played_today: false };
  const filter = ownerFilter(userId, clientId);
  if (!filter) return empty;

  const { data: locks } = await db.from("mp_court_take_locks")
    .select("day_id")
    .or(filter);
  const dayIds = [...new Set((locks ?? []).map((row: any) => row.day_id).filter(Boolean))];
  if (!dayIds.length) return empty;

  const { data: days } = await db.from("mp_court_days")
    .select("id, day")
    .in("id", dayIds);
  const dates = new Set<string>();
  for (const row of days ?? []) dates.add(String(row.day));
  if (!dates.size) return empty;
  const sorted = [...dates].sort();
  return {
    current: computeStreak(dates, today),
    last_played: sorted[sorted.length - 1],
    played_today: dates.has(today),
  };
}

async function takeLocks(dayId: string) {
  const { data } = await db.from("mp_court_take_locks")
    .select("id, author_client_id, author_user_id, author_label, answers, created_at")
    .eq("day_id", dayId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

export async function actionCourtDaily(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId = safeClientId(body.client_id);
  const day = dayFromBody(body);
  const courtDay = await getOrCreateCourtDay(day);
  if (!courtDay) return err("court_day_unavailable", 500);

  const locks = await takeLocks(courtDay.id);
  const mine = locks.find((l: any) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
  const items = courtDay.house_take.items;
  return ok({
    date: courtDay.day,
    day: { id: courtDay.id, share_token: courtDay.share_token },
    take: courtDay.house_take,
    your_answers: mine?.answers ?? {},
    take_done: !!mine,
    done: !!mine,
    beats: { take: !!mine, challenge: false, full_stack: false },
    consensus: mine ? takeConsensus(items, locks as any[]) : null,
    consensus_gate: { have: locks.length, honest_empty: locks.length <= 1 },
    streak: await courtStreak(userId, clientId, courtDay.day),
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
  const patch = {
    answers: normalized.answers,
    author_label: String(body.label ?? "Anonymous").slice(0, 40),
    updated_at: new Date().toISOString(),
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
    });
    if (insertErr) {
      const raced = await takeLocks(courtDay.id);
      const racedMine = raced.find((l: any) => (userId && l.author_user_id === userId) || (clientId && l.author_client_id === clientId));
      if (!racedMine) return err(insertErr.message, 500);
      await db.from("mp_court_take_locks").update(patch).eq("id", racedMine.id);
    }
  }

  const after = await takeLocks(courtDay.id);
  return ok({
    locked: true,
    date: courtDay.day,
    day: { id: courtDay.id, share_token: courtDay.share_token },
    take: courtDay.house_take,
    your_answers: normalized.answers,
    done: true,
    beats: { take: true, challenge: false, full_stack: false },
    consensus: takeConsensus(items, after as any[]),
    consensus_gate: { have: after.length, honest_empty: after.length <= 1 },
    streak: await courtStreak(userId, clientId, courtDay.day),
  });
}
