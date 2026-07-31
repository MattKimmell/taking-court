-- =========================================================================
-- 0001  Async multiplayer mode for the NBA Top-8 list game.
-- Additive only: new normalize helper + two new tables. Nothing existing is
-- modified. Gameplay is server-authoritative via edge functions (service role);
-- RLS is enabled with no client policies so answer sets stay hidden from clients.
-- Applied to project ubadgdkajflkmmbmgeov on 2026-07-21.
-- =========================================================================

-- Deterministic name normalizer (matches perfect_sheet alias_normalized:
-- lowercase, accent-folded, alphanumeric only). Kept in sync with the TS
-- normalizer used inside the edge function.
create or replace function public.mp_normalize(txt text)
returns text
language sql
immutable
as $$
  select regexp_replace(
    translate(
      lower(coalesce(txt, '')),
      'áàâäãåéèêëíìîïóòôöõúùûüñçšžćčđ',
      'aaaaaaeeeeiiiiooooouuuuncszccdc'
    ),
    '[^a-z0-9]', '', 'g'
  );
$$;

-- ---------------------------------------------------------------------------
-- Challenge record: one per async duel or private competition.
-- Freezes the category, the 8 accepted answers, question version, start
-- conditions, expiration and rules so every participant plays an identical game.
-- ---------------------------------------------------------------------------
create table public.mp_challenges (
  id                uuid primary key default gen_random_uuid(),
  share_token       text not null unique,
  sheet_id          uuid not null references public.perfect_sheets(id),
  mode              text not null default 'duel'
                      check (mode in ('duel','competition')),
  status            text not null default 'open'
                      check (status in ('open','closed')),

  -- frozen content (snapshot taken at creation)
  prompt            text not null,
  answer_target     smallint not null default 8 check (answer_target between 1 and 15),
  question_version  integer  not null default 1,
  answers_snapshot  jsonb    not null,   -- [{slot, display_name, canonical_key, accepted[], context_label}]
  source_data_asof  timestamptz,

  -- frozen rules
  strike_limit      smallint not null default 3 check (strike_limit >= 1),
  rules             jsonb    not null default '{}'::jsonb,
  max_participants  integer,             -- null = unlimited; duels use 2
  require_auth      boolean  not null default false,

  -- creator identity (anon client_id and/or authenticated user)
  creator_client_id text,
  creator_user_id   uuid references auth.users(id),
  creator_label     text,

  -- lifecycle (server clock)
  created_at        timestamptz not null default now(),
  starts_at         timestamptz,
  expires_at        timestamptz not null default (now() + interval '30 days'),
  closed_at         timestamptz
);

create index mp_challenges_sheet  on public.mp_challenges(sheet_id);
create index mp_challenges_status on public.mp_challenges(status);

-- ---------------------------------------------------------------------------
-- Attempt record: one per participant per challenge. Holds the guess log,
-- strikes, correct count, server-authoritative timing and final ranking.
-- ---------------------------------------------------------------------------
create table public.mp_attempts (
  id                uuid primary key default gen_random_uuid(),
  challenge_id      uuid not null references public.mp_challenges(id) on delete cascade,
  role              text not null default 'participant'
                      check (role in ('creator','opponent','participant')),

  -- identity
  player_client_id  text,
  player_user_id    uuid references auth.users(id),
  player_label      text not null default 'Player',
  -- secret bearer that authorizes this attempt's guess/finish actions (anon play)
  attempt_token     text not null unique default encode(gen_random_bytes(16), 'hex'),

  -- progress
  status            text not null default 'in_progress'
                      check (status in ('in_progress','completed','eliminated','expired')),
  correct_count     smallint not null default 0 check (correct_count >= 0),
  strikes           smallint not null default 0 check (strikes >= 0),
  filled_slots      jsonb    not null default '{}'::jsonb,  -- { "1": {name, at_ms}, ... }
  guesses           jsonb    not null default '[]'::jsonb,  -- [{seq, at_ms, raw, normalized, result, slot}]

  -- server-authoritative timing
  started_at        timestamptz,
  finished_at       timestamptz,
  last_correct_at   timestamptz,      -- used for ranking-time of non-finishers
  elapsed_ms        integer,          -- finished_at - started_at
  ranking_time_ms   integer,          -- finishers: total; else time to reach final score
  rank              integer,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index mp_attempts_challenge on public.mp_attempts(challenge_id);
-- one attempt per identity per challenge
create unique index mp_attempts_one_per_client
  on public.mp_attempts(challenge_id, player_client_id)
  where player_client_id is not null;
create unique index mp_attempts_one_per_user
  on public.mp_attempts(challenge_id, player_user_id)
  where player_user_id is not null;

-- Lock both tables away from direct client access. All reads/writes go through
-- the edge function using the service role, which enforces the "answers hidden
-- until you finish" and "opponent hidden until they finish" rules. RLS on with
-- no policies = deny-all for anon/authenticated; service role bypasses RLS.
alter table public.mp_challenges enable row level security;
alter table public.mp_attempts   enable row level security;

comment on table public.mp_challenges is
  'Async multiplayer challenge/competition. Frozen category + accepted answers + rules. Answers hidden from clients via RLS; served only through server-authoritative edge functions.';
comment on table public.mp_attempts is
  'Per-participant attempt. Server-authoritative timing + validated guesses. Results hidden from other participants until finished.';
