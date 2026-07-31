-- =========================================================================
-- 0011  Tier-list mode. Applied to project ubadgdkajflkmmbmgeov on 2026-07-23.
-- A topic defines a candidate pool (pool_source); the mp edge function "spins"
-- a random subset (item_set, frozen) that everyone sorts into tiers
-- (S/A/B/C/D/F). Compared per item across authors (modal + average tier).
-- Endpoints: tier_create, tier_reroll, tier_open, tier_save, tier_compare,
-- tier_mine, tier_browse. Pools: star_players (DB view), all_teams,
-- champion_teams, notable_coaches (constants in the function).
-- =========================================================================
create table if not exists public.mp_tier_topics (
  id uuid primary key default gen_random_uuid(),
  share_token text not null unique,
  prompt text not null check (char_length(trim(prompt)) > 0),
  item_type text not null default 'player' check (item_type in ('player','team','coach')),
  pool_source text not null,                 -- star_players | all_teams | champion_teams | notable_coaches
  pool_params jsonb not null default '{}'::jsonb,
  draw_size smallint not null default 8 check (draw_size between 4 and 16),
  tiers text[] not null default array['S','A','B','C','D','F'],
  item_set jsonb not null,                   -- frozen drawn set: [{key,label}]
  visibility text not null default 'public' check (visibility in ('public','unlisted')),
  creator_client_id text,
  creator_user_id uuid references auth.users(id),
  creator_label text,
  created_at timestamptz not null default now()
);
create index if not exists mp_tier_topics_public on public.mp_tier_topics(visibility, created_at desc);

create table if not exists public.mp_tier_lists (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.mp_tier_topics(id) on delete cascade,
  author_client_id text,
  author_user_id uuid references auth.users(id),
  author_label text not null default 'Anonymous',
  assignments jsonb not null default '{}'::jsonb,   -- { item_key: "S"|"A"|"B"|"C"|"D"|"F" }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mp_tier_lists_topic on public.mp_tier_lists(topic_id);
create unique index if not exists mp_tier_lists_one_client
  on public.mp_tier_lists(topic_id, author_client_id) where author_client_id is not null;
create unique index if not exists mp_tier_lists_one_user
  on public.mp_tier_lists(topic_id, author_user_id) where author_user_id is not null;

alter table public.mp_tier_topics enable row level security;
alter table public.mp_tier_lists  enable row level security;

-- 0010 (seed 5 public list topics) and 0012 (seed 3 tier topics) were applied as
-- data-only migrations; see chat history for the exact seed statements. Remove
-- all seeded social content with:
--   delete from mp_list_topics where creator_client_id = 'seed';
--   delete from mp_tier_topics where creator_client_id = 'seed';
