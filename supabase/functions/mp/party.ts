// -----------------------------------------------------------------------------
// Pickup: in-person co-op. A host starts a session and shows a join code; friends
// join on their own phones and everyone contributes toward a shared target.
//
// Deliberately unlike every other mode here:
//   - No accounts. Any auth step in a bar kills this.
//   - No strikes. Eight excited people guess wrong constantly; three strikes
//     would end the party in twenty seconds and punish the group for one person.
//     Pressure comes from the timer; misses are a celebratory stat.
//   - No per-person ranking. Contribution counts in the recap are fun; a live
//     leaderboard makes the guy who knows the most win and everyone else stop
//     shouting.
//   - No read-modify-write. mp_party_answers' primary key (session_id,
//     player_key) is the dedupe, so Postgres arbitrates concurrent submissions.
// -----------------------------------------------------------------------------
import {
  db, ok, err, authedUserId, normalize, randomToken,
  matchPoolGuess, rosterReveal, RARITY_LABEL,
} from "./shared.ts";
import type { PoolEntry } from "./shared.ts";
import { makeCrewCode } from "./crews.ts";

const MAX_LABEL = 24;
const PG_UNIQUE_VIOLATION = "23505";

async function uniquePartyCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const c = makeCrewCode();
    const { data } = await db.from("mp_party_sessions").select("id").eq("code", c).maybeSingle();
    if (!data) return c;
  }
  return makeCrewCode();
}

function cleanLabel(v: unknown, fallback = "Player"): string {
  return (String(v ?? "").trim() || fallback).slice(0, MAX_LABEL);
}

// Sessions end on their own so a host whose phone locks can't strand the room.
// Called lazily from state/guess rather than by a scheduler.
async function autoEndIfExpired(session: any) {
  if (session.status !== "live" || !session.ends_at) return session;
  if (new Date(session.ends_at).getTime() > Date.now()) return session;
  const { data } = await db.from("mp_party_sessions")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("id", session.id).eq("status", "live").select("*").single();
  return data ?? { ...session, status: "ended" };
}

function secondsLeft(session: any): number | null {
  if (!session.ends_at) return null;
  return Math.max(0, Math.round((new Date(session.ends_at).getTime() - Date.now()) / 1000));
}

function publicSession(s: any) {
  return {
    id: s.id, code: s.code, share_token: s.share_token, prompt: s.prompt,
    target: s.target, status: s.status, misses: s.misses,
    time_limit_s: s.time_limit_s, seconds_left: secondsLeft(s),
  };
}

async function boardSince(sessionId: string, sinceId: number) {
  const { data } = await db.from("mp_party_answers")
    .select("id, player_key, display_name, rarity_tier, member_label")
    .eq("session_id", sessionId).gt("id", sinceId).order("id", { ascending: true });
  return (data ?? []).map((a) => ({
    id: a.id, player_key: a.player_key, display_name: a.display_name,
    rarity_tier: a.rarity_tier, rarity_label: RARITY_LABEL[a.rarity_tier ?? ""] ?? null,
    member_label: a.member_label,
  }));
}

async function answerCount(sessionId: string): Promise<number> {
  const { count } = await db.from("mp_party_answers")
    .select("player_key", { count: "exact", head: true }).eq("session_id", sessionId);
  return count ?? 0;
}

async function loadSessionByCode(code: string) {
  const { data } = await db.from("mp_party_sessions").select("*")
    .eq("code", code.trim().toUpperCase()).maybeSingle();
  return data;
}

// Verifies the caller is a real member of this session. Party play is anonymous,
// so the member_token is the only credential.
async function requireMember(sessionId: string, memberId: string, token: string) {
  if (!memberId || !token) return null;
  const { data } = await db.from("mp_party_members").select("id, label")
    .eq("id", memberId).eq("session_id", sessionId).eq("member_token", token).maybeSingle();
  return data;
}

// -----------------------------------------------------------------------------
export async function actionPartyPrompts() {
  const { data } = await db.from("mp_party_prompts")
    .select("slug, prompt, target, item_type")   // never the pool
    .eq("status", "approved").order("sort_order", { ascending: true });
  return ok({ prompts: data ?? [] });
}

export async function actionPartyCreate(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!clientId) return err("identity_required", 400);

  const slug = String(body.slug ?? "");
  const { data: prompt } = await db.from("mp_party_prompts").select("*")
    .eq("slug", slug).eq("status", "approved").maybeSingle();
  if (!prompt) return err("unknown_prompt", 404);

  // 3 / 5 / 10 minutes, or untimed. Anything else is rejected rather than clamped
  // so a bad client can't quietly create a 6-hour session.
  const raw = body.time_limit_s === null ? null : Number(body.time_limit_s ?? 300);
  if (raw !== null && ![180, 300, 600].includes(raw)) return err("invalid_time_limit", 400);

  const code = await uniquePartyCode();
  const hostToken = randomToken(16);
  const { data: session, error: sErr } = await db.from("mp_party_sessions").insert({
    code, share_token: "party_" + randomToken(8),
    prompt_id: prompt.id, prompt: prompt.prompt, target: prompt.target,
    answers_snapshot: prompt.pool,       // freeze: editing the prompt can't change a live game
    status: "lobby", time_limit_s: raw,
    host_client_id: clientId, host_token: hostToken,
  }).select("*").single();
  if (sErr) return err(sErr.message, 500);

  const memberToken = randomToken(16);
  const { data: member } = await db.from("mp_party_members").insert({
    session_id: session.id, client_id: clientId, user_id: userId,
    label: cleanLabel(body.label, "Host"), member_token: memberToken,
  }).select("id, label").single();

  return ok({
    session: publicSession(session), host_token: hostToken,
    member_id: member?.id, member_token: memberToken, is_host: true,
    members: [{ id: member?.id, label: member?.label }],
  });
}

// Idempotent for a returning device: a refresh, a reconnect, or a phone locking
// mid-game must resume the same member rather than minting a second identity.
// Works in `live` as well as `lobby` — late joiners are the norm at a party.
export async function actionPartyJoin(req: Request, body: any) {
  const userId = authedUserId(req);
  const clientId: string | null = body.client_id ?? null;
  if (!clientId) return err("identity_required", 400);

  const session = body.code ? await loadSessionByCode(String(body.code)) : null;
  if (!session) return err("unknown_session", 404);
  if (new Date(session.expires_at).getTime() < Date.now()) return err("session_expired", 410);
  const live = await autoEndIfExpired(session);
  if (live.status === "ended") return err("session_ended", 410);

  // Resume by token first, then by device. Either path returns the original member.
  let member = null;
  if (body.member_token) {
    const { data } = await db.from("mp_party_members").select("id, label, member_token")
      .eq("session_id", live.id).eq("member_token", String(body.member_token)).maybeSingle();
    member = data;
  }
  if (!member) {
    const { data } = await db.from("mp_party_members").select("id, label, member_token")
      .eq("session_id", live.id).eq("client_id", clientId).maybeSingle();
    member = data;
  }
  // Re-joining with a name attached is how renaming works — no separate action,
  // and it keeps the join path free of a blocking name prompt.
  if (member && body.label) {
    const label = cleanLabel(body.label);
    if (label !== member.label) {
      await db.from("mp_party_members").update({ label }).eq("id", member.id);
      await db.from("mp_party_answers").update({ member_label: label })
        .eq("session_id", live.id).eq("member_id", member.id);
      member.label = label;
    }
  }
  if (!member) {
    const token = randomToken(16);
    const { data, error } = await db.from("mp_party_members").insert({
      session_id: live.id, client_id: clientId, user_id: userId,
      label: cleanLabel(body.label), member_token: token,
    }).select("id, label, member_token").single();
    if (error) {
      // Lost a race with our own other tab — the partial unique index fired.
      // Re-read rather than surfacing a failure.
      if (error.code === PG_UNIQUE_VIOLATION) {
        const { data: existing } = await db.from("mp_party_members").select("id, label, member_token")
          .eq("session_id", live.id).eq("client_id", clientId).maybeSingle();
        member = existing;
      }
      if (!member) return err(error.message, 500);
    } else member = data;
  }

  const { data: members } = await db.from("mp_party_members")
    .select("id, label").eq("session_id", live.id).order("joined_at", { ascending: true });

  return ok({
    session: publicSession(live),
    member_id: member!.id, member_token: member!.member_token,
    is_host: live.host_client_id === clientId,
    members: members ?? [],
    board: await boardSince(live.id, 0),
    count: await answerCount(live.id),
  });
}

export async function actionPartyStart(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  if (session.host_token !== String(body.host_token ?? "")) return err("only_host_can_start", 403);
  if (session.status === "ended") return err("session_ended", 410);
  if (session.status === "live") return ok({ session: publicSession(session), already: true });

  const startedAt = new Date();
  const endsAt = session.time_limit_s
    ? new Date(startedAt.getTime() + session.time_limit_s * 1000).toISOString() : null;
  const { data: updated } = await db.from("mp_party_sessions")
    .update({ status: "live", started_at: startedAt.toISOString(), ends_at: endsAt })
    .eq("id", session.id).eq("status", "lobby").select("*").single();

  return ok({ session: publicSession(updated ?? session) });
}

export async function actionPartyGuess(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  const member = await requireMember(session.id, String(body.member_id ?? ""), String(body.member_token ?? ""));
  if (!member) return err("not_a_member", 403);

  const live = await autoEndIfExpired(session);
  if (live.status !== "live") return err("session_not_live", 409, { status: live.status });

  const norm = normalize(String(body.guess ?? ""));
  if (!norm) return err("empty_guess", 400);

  const pool = (Array.isArray(live.answers_snapshot) ? live.answers_snapshot : []) as PoolEntry[];
  const hit = matchPoolGuess(pool, norm);
  const sinceId = Number(body.since_id ?? 0);

  if (!hit) {
    // A miss is a stat, never a penalty. Atomic bump — no read-modify-write.
    await db.rpc("mp_party_bump_miss", { p_session: live.id });
    return ok({
      result: "miss", count: await answerCount(live.id), target: live.target,
      answers: await boardSince(live.id, sinceId),
      seconds_left: secondsLeft(live),
    });
  }

  const { error: iErr } = await db.from("mp_party_answers").insert({
    session_id: live.id, player_key: hit.player_key, display_name: hit.display_name,
    rarity_tier: hit.rarity_tier, member_id: member.id, member_label: member.label,
  });

  if (iErr) {
    // Someone else got there first. Friendlier than a strike, and the reason the
    // dedupe lives in the primary key instead of in JavaScript.
    if (iErr.code === PG_UNIQUE_VIOLATION) {
      const { data: prior } = await db.from("mp_party_answers")
        .select("member_label").eq("session_id", live.id).eq("player_key", hit.player_key).maybeSingle();
      return ok({
        result: "duplicate", display_name: hit.display_name,
        claimed_by: prior?.member_label ?? null,
        count: await answerCount(live.id), target: live.target,
        answers: await boardSince(live.id, sinceId), seconds_left: secondsLeft(live),
      });
    }
    return err(iErr.message, 500);
  }

  const count = await answerCount(live.id);
  const finished = count >= live.target;
  if (finished) {
    await db.from("mp_party_sessions")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("id", live.id).eq("status", "live");
  }

  return ok({
    result: "correct", display_name: hit.display_name,
    rarity_tier: hit.rarity_tier, rarity_label: RARITY_LABEL[hit.rarity_tier] ?? hit.rarity_tier,
    count, target: live.target, finished,
    answers: await boardSince(live.id, sinceId),   // piggybacked delta: the typer never waits
    seconds_left: secondsLeft(live),
  });
}

export async function actionPartyState(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  const live = await autoEndIfExpired(session);

  const sinceId = Number(body.since_id ?? 0);
  const { data: members } = await db.from("mp_party_members")
    .select("id, label").eq("session_id", live.id).order("joined_at", { ascending: true });

  const out: Record<string, unknown> = {
    session: publicSession(live), members: members ?? [],
    answers: await boardSince(live.id, sinceId), count: await answerCount(live.id),
  };
  if (live.status === "ended") out.recap = await buildRecap(live);
  return ok(out);
}

export async function actionPartyEnd(_req: Request, body: any) {
  const { data: session } = await db.from("mp_party_sessions").select("*")
    .eq("id", body.session_id).maybeSingle();
  if (!session) return err("unknown_session", 404);
  if (session.host_token !== String(body.host_token ?? "")) return err("only_host_can_end", 403);
  if (session.status !== "ended") {
    await db.from("mp_party_sessions")
      .update({ status: "ended", ended_at: new Date().toISOString() }).eq("id", session.id);
    session.status = "ended";
  }
  return ok({ session: publicSession(session), recap: await buildRecap(session) });
}

// The recap is the product: it's what gets screenshotted into the group chat.
async function buildRecap(session: any) {
  const { data: rows } = await db.from("mp_party_answers")
    .select("player_key, display_name, rarity_tier, member_label")
    .eq("session_id", session.id).order("id", { ascending: true });
  const answers = rows ?? [];

  const byMember = new Map<string, number>();
  for (const a of answers) {
    const k = a.member_label ?? "Someone";
    byMember.set(k, (byMember.get(k) ?? 0) + 1);
  }

  const pool = (Array.isArray(session.answers_snapshot) ? session.answers_snapshot : []) as PoolEntry[];
  const found = new Set(answers.map((a) => a.player_key));
  // rosterReveal already sorts by fame, so filtering it yields the most famous
  // names nobody said — the "oh come ON" moment.
  const missed = rosterReveal(pool.filter((p) => !found.has(p.player_key)), 5)
    .map((m) => ({ display_name: m.display_name, context_label: m.context_label }));

  return {
    prompt: session.prompt, target: session.target,
    count: answers.length, misses: session.misses,
    deep_cuts: answers.filter((a) => a.rarity_tier === "deep_cut")
      .map((a) => a.display_name),
    contributors: Array.from(byMember, ([label, n]) => ({ label, n }))
      .sort((a, b) => b.n - a.n),
    missed,
  };
}
