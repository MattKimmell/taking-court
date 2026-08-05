-- =========================================================================
-- 0035  Pickup becomes a night: three rounds, one recap.
--
-- A session was one prompt, five minutes, a recap, and "Run it back" with the
-- same prompt — one game replayed. A room of four puts their phones down after
-- the second go. This makes a session a sequence of rounds of different shapes:
--
--   1  rapid      co-op shared board, shout names        (today's game, 120s)
--   2  consensus  everyone privately tiers 5 players     (untimed, host advances)
--   3  sudden     turn-based elimination                 (15s per turn)
--
-- WHY ROUND 2 IS PARTY-NATIVE AND NOT mp_tier_topics.
-- consensusFor() and scoreBoard() in shared.ts are pure functions — boards
-- arrive as a parameter and neither one queries. So the whole scoring machinery
-- is reusable without a tier table in sight, which buys three things:
--   * zero exposure for shipped tier output (the share grid's item order, the
--     consensus column sort, Hottest Take's divisor — all documented as
--     must-not-shift)
--   * party boards never leak into Browse or "My takes"
--   * a room's opinions can never move a public theme's consensus, and the 144
--     live demo boards can never move a room's score
--
-- WHY SUDDEN DEATH BREAKS THE "NO STRIKES" RULE ON PURPOSE.
-- 0018's no-strikes reasoning is about the CO-OP round: eight excited people
-- guess wrong constantly and the group should not be punished for one person.
-- Round 1 keeps that rule exactly. Round 3 is a different contract the room
-- opts into — elimination IS the game. Do not "make these consistent" in
-- either direction.
--
-- Additive. mp_party_answers is NOT touched: only the rapid round writes it and
-- there is one rapid round per session, so its (session_id, player_key) primary
-- key is still exactly right.
-- =========================================================================

-- 'classic' is every session that exists today and every session a cached client
-- can create, since an old shell never sends `format`.
alter table public.mp_party_sessions
  add column if not exists format text not null default 'classic'
    check (format in ('classic', 'night'));

-- No current_round column. Which round is active is derivable from the round
-- statuses (live > else the highest ended > else the lowest pending), and a
-- stored copy is a cache that drifts against the rows that produced it. Same
-- reasoning as elimination below.
create table if not exists public.mp_party_rounds (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.mp_party_sessions(id) on delete cascade,
  idx smallint not null check (idx between 1 and 8),
  kind text not null check (kind in ('rapid', 'consensus', 'sudden')),
  status text not null default 'pending' check (status in ('pending', 'live', 'ended')),
  prompt text not null,
  target smallint,                 -- rapid only
  item_set jsonb,                  -- consensus only: [{key,label}]
  tiers text[],                    -- consensus only
  turn_member_id uuid references public.mp_party_members(id) on delete set null,
  turn_seq integer not null default 0,     -- sudden only: the compare-and-swap token
  turn_expires_at timestamptz,
  -- The clock. For a classic session the SESSION clock stays authoritative and
  -- this mirrors it, so autoEndIfExpired and secondsLeft() keep behaving byte
  -- for byte as they do today. For a night the session has no clock and this is
  -- the only one.
  time_limit_s integer,
  started_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, idx)
);
create index if not exists mp_party_rounds_session
  on public.mp_party_rounds (session_id, idx);

-- One board per member per round. The PRIMARY KEY is the rule, the same device
-- mp_party_answers uses — so a double-tap or two tabs cannot produce two boards
-- and there is no read-modify-write in the save path.
create table if not exists public.mp_party_round_boards (
  round_id uuid not null references public.mp_party_rounds(id) on delete cascade,
  member_id uuid not null references public.mp_party_members(id) on delete cascade,
  member_label text,
  assignments jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (round_id, member_id)
);

create table if not exists public.mp_party_turns (
  id bigserial primary key,
  round_id uuid not null references public.mp_party_rounds(id) on delete cascade,
  member_id uuid references public.mp_party_members(id) on delete set null,
  member_label text,
  guess text not null default '',
  player_key text,
  outcome text not null check (outcome in ('correct', 'miss', 'timeout', 'duplicate')),
  created_at timestamptz not null default now()
);
-- A name is spent once per sudden-death round, and the index is the dedupe: a
-- repeat raises 23505 rather than racing a read.
create unique index if not exists mp_party_turns_used
  on public.mp_party_turns (round_id, player_key) where player_key is not null;
create index if not exists mp_party_turns_round
  on public.mp_party_turns (round_id, id);

-- ELIMINATION IS DERIVED, NEVER STORED. A member is out of a sudden-death round
-- iff they have a turn row in it whose outcome ends their run. A cached is_out
-- flag would be a second copy of a fact the turn log already holds, free to
-- drift; this cannot. Same instinct as soloStreak and mp_funnel.
create or replace function public.mp_party_alive(p_round uuid)
returns table (member_id uuid, label text, rn bigint)
language sql stable as $$
  select f.id, f.label, f.rn
    from (select m.id, m.label,
                 row_number() over (order by m.joined_at, m.id) rn
            from public.mp_party_members m
            join public.mp_party_rounds r on r.id = p_round
           where m.session_id = r.session_id) f
   where not exists (
     select 1 from public.mp_party_turns t
      where t.round_id = p_round and t.member_id = f.id
        and t.outcome in ('miss', 'timeout', 'duplicate'));
$$;

comment on function public.mp_party_alive(uuid) is
  'Members still standing in a sudden-death round, in rotation order. Derived from the turn log — there is no is_out column to keep in sync.';

-- -------------------------------------------------------------------------
-- The one piece of genuinely concurrent logic in the round system, and it is a
-- COMPARE-AND-SWAP rather than a read-modify-write.
--
-- Two callers can arrive at the same instant: the player whose turn it is
-- submitting a guess, and any other device's poll noticing the turn clock has
-- run out. `for update` serialises them on the round row; the loser then sees a
-- bumped turn_seq and is told so. Postgres arbitrates — exactly the role
-- mp_party_answers' primary key plays in the rapid round.
--
-- p_timeout records the elimination INSIDE the guarded call, so two polls firing
-- together cannot both write a timeout row for the same turn.
-- -------------------------------------------------------------------------
create or replace function public.mp_party_advance_turn(
  p_round uuid,
  p_expect_seq integer,
  p_turn_s integer,
  p_timeout boolean default false)
returns jsonb language plpgsql as $$
declare
  r         record;
  v_cur_rn  bigint;
  v_next    uuid;
  v_alive   bigint;
begin
  select * into r from public.mp_party_rounds where id = p_round for update;
  if not found then
    return jsonb_build_object('advanced', false, 'reason', 'unknown_round');
  end if;
  if r.kind <> 'sudden' or r.status <> 'live' then
    return jsonb_build_object('advanced', false, 'reason', 'round_not_live');
  end if;
  -- The swap half of the compare-and-swap.
  if r.turn_seq <> p_expect_seq then
    return jsonb_build_object('advanced', false, 'reason', 'stale_seq',
                              'turn_seq', r.turn_seq);
  end if;

  if p_timeout and r.turn_member_id is not null then
    insert into public.mp_party_turns (round_id, member_id, member_label, guess, outcome)
    select r.id, m.id, m.label, '', 'timeout'
      from public.mp_party_members m where m.id = r.turn_member_id;
  end if;

  -- Where the outgoing player sat in the FULL rotation. Not the alive rotation:
  -- they may have just been eliminated and dropped out of it.
  select q.rn into v_cur_rn from (
    select m.id, row_number() over (order by m.joined_at, m.id) rn
      from public.mp_party_members m where m.session_id = r.session_id
  ) q where q.id = r.turn_member_id;
  v_cur_rn := coalesce(v_cur_rn, 0);

  -- Next survivor after them, wrapping. Booleans sort false-first ascending, so
  -- `rn <= v_cur_rn` puts everyone AFTER the current seat ahead of the wrap.
  -- count(*) over () rides along so one query yields both the seat and the
  -- headcount.
  select a.member_id, a.n into v_next, v_alive
    from (select al.member_id, al.rn, count(*) over () n
            from public.mp_party_alive(p_round) al) a
   order by (a.rn <= v_cur_rn), a.rn
   limit 1;
  v_alive := coalesce(v_alive, 0);

  -- One left is a winner; nobody left is a draw. Either way the round is over.
  if v_alive <= 1 then
    update public.mp_party_rounds
       set status = 'ended', ended_at = now(),
           turn_member_id = null, turn_expires_at = null,
           turn_seq = turn_seq + 1
     where id = r.id;
    return jsonb_build_object('advanced', true, 'ended', true,
                              'alive', v_alive, 'winner_member_id', v_next);
  end if;

  update public.mp_party_rounds
     set turn_member_id = v_next, turn_seq = turn_seq + 1,
         turn_expires_at = now() + make_interval(secs => p_turn_s)
   where id = r.id;
  return jsonb_build_object('advanced', true, 'ended', false,
                            'turn_member_id', v_next,
                            'turn_seq', r.turn_seq + 1, 'alive', v_alive);
end $$;

comment on function public.mp_party_advance_turn(uuid, integer, integer, boolean) is
  'Compare-and-swap turn advance for a sudden-death round. Guarded on turn_seq so a guess submit and a lazy timeout sweep cannot both win; records the timeout elimination inside the same guarded call.';

alter table public.mp_party_rounds       enable row level security;
alter table public.mp_party_round_boards enable row level security;
alter table public.mp_party_turns        enable row level security;
-- intentionally no policies: service role only, same as every other mp_ table
