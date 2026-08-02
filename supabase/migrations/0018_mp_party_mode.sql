-- =========================================================================
-- 0018  Pickup mode: in-person co-op sessions. A host starts a session and
-- shows a join code; friends join on their own phones and everyone contributes
-- answers toward a shared target ("name 25 players drafted top 3").
--
-- Deliberately NOT reusing mp_challenges/mp_attempts. Three CHECK constraints
-- rule it out (mp_challenges.answer_target 1..15 — we need 25; mode in
-- duel|competition; mp_roster_sheets.target 3..12), and actionGuess does a
-- read-modify-write on a JSONB blob, which silently drops answers when several
-- people submit at once. Here the primary key (session_id, player_key) IS the
-- dedupe: Postgres arbitrates the race, not JavaScript.
--
-- Additive. To undo: drop the four tables (answers/members cascade from
-- sessions, so drop sessions last).
-- =========================================================================

-- Curated content. Pools are hand-authored and frozen — no random spin, so
-- every group that plays a prompt faces the identical set.
create table if not exists public.mp_party_prompts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  prompt text not null,
  target smallint not null check (target between 5 and 60),
  item_type text not null default 'player',
  -- PoolEntry[]: {player_key, display_name, accepted[], rarity_tier, rarity_score}
  pool jsonb not null default '[]'::jsonb,
  status text not null default 'approved' check (status in ('draft','approved','retired')),
  sort_order smallint not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists public.mp_party_sessions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                  -- short typeable join code
  share_token text not null unique,
  prompt_id uuid references public.mp_party_prompts(id),
  prompt text not null,
  target smallint not null,
  -- frozen copy of mp_party_prompts.pool, so editing a prompt can't change a
  -- live game (same reasoning as mp_challenges.answers_snapshot)
  answers_snapshot jsonb not null default '[]'::jsonb,
  status text not null default 'lobby' check (status in ('lobby','live','ended')),
  time_limit_s integer,                       -- null = untimed
  misses integer not null default 0,          -- bumped atomically, never read-modify-write
  host_client_id text,
  host_token text not null,                   -- gates start/end only
  started_at timestamptz,
  ends_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 day')
);
create index if not exists mp_party_sessions_code on public.mp_party_sessions(code);

create table if not exists public.mp_party_members (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.mp_party_sessions(id) on delete cascade,
  client_id text,
  user_id uuid,
  label text not null default 'Player',
  member_token text not null,
  joined_at timestamptz not null default now()
);
-- One member per device per session. Conditional uniqueness in Postgres is a
-- PARTIAL UNIQUE INDEX — a table-level UNIQUE (...) WHERE ... is not valid DDL.
-- party_join resumes the existing member rather than letting this fire, so a
-- refresh or a phone locking mid-game doesn't mint a second identity.
create unique index if not exists mp_party_members_session_client_unique
  on public.mp_party_members (session_id, client_id)
  where client_id is not null;

create table if not exists public.mp_party_answers (
  id bigserial not null,
  session_id uuid not null references public.mp_party_sessions(id) on delete cascade,
  player_key text not null,
  display_name text not null,
  rarity_tier text,
  member_id uuid references public.mp_party_members(id) on delete set null,
  member_label text,
  created_at timestamptz not null default now(),
  -- the dedupe: a concurrent duplicate raises 23505 and the client renders
  -- "Dave beat you to it" instead of losing the answer
  primary key (session_id, player_key)
);
-- poll cursor: "everything in this session after id N"
create index if not exists mp_party_answers_cursor on public.mp_party_answers (session_id, id);

-- Misses are a stat, not a penalty. Bumped in SQL so eight phones missing at
-- once can't lose counts to a read-modify-write race.
create or replace function public.mp_party_bump_miss(p_session uuid)
returns void language sql as $$
  update public.mp_party_sessions set misses = misses + 1 where id = p_session;
$$;

alter table public.mp_party_prompts  enable row level security;
alter table public.mp_party_sessions enable row level security;
alter table public.mp_party_members  enable row level security;
alter table public.mp_party_answers  enable row level security;
-- intentionally no policies: service role only, same as every other mp_ table
