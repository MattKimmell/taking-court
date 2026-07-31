-- =========================================================================
-- 0013  Crews: account-gated private group rooms that play the Daily together.
-- Applied to project ubadgdkajflkmmbmgeov on 2026-07-31 (captured here for
-- version control). All access via the mp edge function (service role);
-- RLS is deny-all (no policies). FKs to auth.users.
--   mp_crews         one row per crew; short join code + name + member cap
--   mp_crew_members  membership (crew_id, user_id) + per-crew display name
--   mp_reactions     emoji reactions on a member's tier board, crew-scoped
-- The crew leaderboard (streaks / Hottest Take / badge) is computed by the
-- function from members' mp_tier_lists on the day's daily topic.
-- =========================================================================
create table if not exists public.mp_crews (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(trim(name)) between 1 and 40),
  created_by uuid references auth.users(id) on delete set null,
  member_cap smallint not null default 20 check (member_cap between 2 and 50),
  created_at timestamptz not null default now()
);

create table if not exists public.mp_crew_members (
  crew_id uuid not null references public.mp_crews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Anonymous' check (char_length(trim(display_name)) between 1 and 40),
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (crew_id, user_id)
);
create index if not exists mp_crew_members_user on public.mp_crew_members(user_id);

create table if not exists public.mp_reactions (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.mp_crews(id) on delete cascade,
  tier_list_id uuid not null references public.mp_tier_lists(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  unique (crew_id, tier_list_id, user_id, emoji)
);
create index if not exists mp_reactions_list on public.mp_reactions(crew_id, tier_list_id);

-- Helps the crew room's per-user board + streak lookups (added during cleanup).
create index if not exists mp_tier_lists_author_user on public.mp_tier_lists(author_user_id);

alter table public.mp_crews        enable row level security;
alter table public.mp_crew_members enable row level security;
alter table public.mp_reactions    enable row level security;

-- Note: migrations 0010 (seed 5 list topics) and 0012 (seed 3 tier topics)
-- were applied as data-only seeds via the SQL console; they are intentionally
-- not reproduced as files (seed content, not schema).
