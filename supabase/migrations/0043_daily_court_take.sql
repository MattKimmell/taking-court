-- =========================================================================
-- 0035  Daily Court day + Take beat.
--
-- First Daily Court slice: one UTC day row binds the house Take and per-player
-- Take locks. Challenge definition is reserved for the next ticket so the same
-- day identity can carry both beats without introducing a parallel daily later.
-- All access remains service-role-only through the mp edge function.
-- =========================================================================

create table if not exists public.mp_court_days (
  id uuid primary key default gen_random_uuid(),
  day date not null unique,
  share_token text not null unique,
  status text not null default 'published' check (status in ('draft','published','retired')),
  house_take jsonb not null,
  challenge_definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (share_token = 'court_' || day::text),
  check (jsonb_typeof(house_take->'items') = 'array'),
  check (jsonb_array_length(house_take->'items') = 3)
);

create table if not exists public.mp_court_take_locks (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references public.mp_court_days(id) on delete cascade,
  author_client_id text,
  author_user_id uuid references auth.users(id),
  author_label text not null default 'Anonymous',
  answers jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (author_client_id is not null or author_user_id is not null),
  check (jsonb_typeof(answers) = 'object')
);

create index if not exists mp_court_take_locks_day
  on public.mp_court_take_locks(day_id);
create index if not exists mp_court_take_locks_author_user
  on public.mp_court_take_locks(author_user_id);
create unique index if not exists mp_court_take_locks_one_client
  on public.mp_court_take_locks(day_id, author_client_id)
  where author_client_id is not null;
create unique index if not exists mp_court_take_locks_one_user
  on public.mp_court_take_locks(day_id, author_user_id)
  where author_user_id is not null;

alter table public.mp_court_days enable row level security;
alter table public.mp_court_take_locks enable row level security;
