-- =========================================================================
-- 0036  Player-authored Takes via share link.
--
-- Link-only Take documents. They are not exposed through Browse in this slice;
-- the mp edge function owns all reads/writes under service role.
-- =========================================================================

create table if not exists public.mp_take_topics (
  id uuid primary key default gen_random_uuid(),
  share_token text not null unique,
  title text not null,
  items jsonb not null,
  visibility text not null default 'unlisted' check (visibility in ('unlisted','public')),
  review_status text not null default 'unsubmitted' check (review_status in ('unsubmitted','pending','approved','rejected')),
  creator_client_id text,
  creator_user_id uuid references auth.users(id),
  creator_label text not null default 'Anonymous',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (creator_client_id is not null or creator_user_id is not null),
  check (jsonb_typeof(items) = 'array'),
  check (jsonb_array_length(items) = 3)
);

create table if not exists public.mp_take_locks (
  id uuid primary key default gen_random_uuid(),
  take_id uuid not null references public.mp_take_topics(id) on delete cascade,
  author_client_id text,
  author_user_id uuid references auth.users(id),
  author_label text not null default 'Anonymous',
  answers jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (author_client_id is not null or author_user_id is not null),
  check (jsonb_typeof(answers) = 'object')
);

create index if not exists mp_take_locks_take
  on public.mp_take_locks(take_id);
create index if not exists mp_take_topics_creator_user
  on public.mp_take_topics(creator_user_id);
create index if not exists mp_take_locks_author_user
  on public.mp_take_locks(author_user_id);
create unique index if not exists mp_take_locks_one_client
  on public.mp_take_locks(take_id, author_client_id)
  where author_client_id is not null;
create unique index if not exists mp_take_locks_one_user
  on public.mp_take_locks(take_id, author_user_id)
  where author_user_id is not null;

alter table public.mp_take_topics enable row level security;
alter table public.mp_take_locks enable row level security;
