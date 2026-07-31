-- =========================================================================
-- 0008  Subjective "make your own list" mode. Applied to project
-- ubadgdkajflkmmbmgeov on 2026-07-21. A topic (shareable prompt, no correct
-- answer) that many people each answer with their own ranked list; stored per
-- author so lists can be revisited, shared, and compared. Served by the mp
-- edge function (list_create / list_save / list_open / list_compare / list_mine).
-- =========================================================================
create table if not exists public.mp_list_topics (
  id uuid primary key default gen_random_uuid(),
  share_token text not null unique,
  prompt text not null check (char_length(trim(prompt)) > 0),
  ranked boolean not null default true,
  max_items smallint not null default 10 check (max_items between 1 and 25),
  creator_client_id text,
  creator_user_id uuid references auth.users(id),
  creator_label text,
  created_at timestamptz not null default now()
);

create table if not exists public.mp_lists (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.mp_list_topics(id) on delete cascade,
  author_client_id text,
  author_user_id uuid references auth.users(id),
  author_label text not null default 'Anonymous',
  items jsonb not null default '[]'::jsonb,   -- [{rank,label,key,note,player_key}]
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mp_lists_topic on public.mp_lists(topic_id);
create unique index if not exists mp_lists_one_per_client
  on public.mp_lists(topic_id, author_client_id) where author_client_id is not null;
create unique index if not exists mp_lists_one_per_user
  on public.mp_lists(topic_id, author_user_id) where author_user_id is not null;

alter table public.mp_list_topics enable row level security;
alter table public.mp_lists       enable row level security;
