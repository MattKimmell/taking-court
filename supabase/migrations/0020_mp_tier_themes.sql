-- =========================================================================
-- 0020  Curated tier themes.
--
-- WHY: a random spin means two people who both "spin 90s legends" get
-- different sets and can never be compared, so consensus fragments per topic
-- and a minimum-board score gate never clears. A theme is a hand-authored
-- FIXED set behind ONE canonical mp_tier_topics row, so every board worldwide
-- pools into the same consensus and the gate clears once, permanently.
--
-- Exactly one theme is `featured`. Concentrating scarce early participation
-- into a single pool is what makes the gate reachable; an equal-weight list
-- of five themes splits the first boards five ways and nothing unlocks.
-- Enforced by a partial unique index rather than by convention.
--
-- Consequence, stated up front: a theme's canonical topic is created once and
-- never mutated (`on conflict do nothing` in the seeder). Changing a shipped
-- theme's items would orphan assignment keys on every board already saved.
-- To change a set, ship a NEW slug.
--
-- Also adds mp_tier_topics.kind, replacing the creator_client_id='daily'
-- sniffing that tier_reroll / tier_browse / tier_mine rely on. That sniff is
-- SPOOFABLE: client_id is read raw from the request body in actionTierReroll,
-- so POST {action:"tier_reroll", share_token:"daily_<today>", client_id:"daily"}
-- passed the creator check and — before anyone had played that day — redrew
-- the Daily and deleted every board on it. `kind` is a property of the row, so
-- no caller can claim it.
--
-- Additive. To undo: drop mp_daily_schedule, drop mp_tier_themes (topics
-- referencing it via theme_id must be dropped or nulled first), then drop the
-- two columns from mp_tier_topics.
-- =========================================================================

-- ---------------------------------------------------------------- themes
create table if not exists public.mp_tier_themes (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  prompt text not null,
  blurb text,                      -- one-line nostalgia hook for the picker
  invite text,                      -- share question; '{item}' is substituted
  item_type text not null default 'player' check (item_type in ('player','team','coach')),
  -- [{key,label}] — key MUST be public.mp_normalize(label); that's what
  -- actionTierSave validates assignments against.
  item_set jsonb not null check (jsonb_array_length(item_set) between 4 and 16),
  status text not null default 'approved' check (status in ('draft','approved','retired')),
  featured boolean not null default false,
  sort_order smallint not null default 100,
  created_at timestamptz not null default now()
);

-- At most one featured theme, ever. Conditional uniqueness in Postgres is a
-- partial unique index; a constant expression makes "at most one matching row"
-- fall out of it. The hero slot must never be ambiguous.
create unique index if not exists mp_tier_themes_one_featured
  on public.mp_tier_themes ((true)) where featured;

-- ---------------------------------------------------------------- daily schedule
-- Which theme the Daily copies, by date. A row means "today's Daily uses this
-- theme's set"; no row means the existing DAILY_ROTATION + drawSet path runs
-- untouched. Deliberately a schedule and not a `daily_eligible` flag with
-- modular rotation: with a small catalogue, eligible[dayIndex % n] serves the
-- identical set every n days, which is staler than today's random re-draw.
create table if not exists public.mp_daily_schedule (
  day date primary key,
  theme_slug text not null references public.mp_tier_themes(slug) on delete restrict,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- topic kind
alter table public.mp_tier_topics
  add column if not exists kind text not null default 'user'
    check (kind in ('user','daily','theme')),
  add column if not exists theme_id uuid references public.mp_tier_themes(id),
  -- Denormalized from the theme so the topic the client opens carries its own
  -- share question, and so a themed Daily can copy the invite along with the
  -- item_set instead of joining back to a theme it only borrowed from.
  add column if not exists invite text;

update public.mp_tier_topics set kind = 'daily'
 where kind = 'user'
   and (creator_client_id = 'daily' or share_token like 'daily\_%');

create index if not exists mp_tier_topics_kind
  on public.mp_tier_topics(kind, created_at desc);

-- ---------------------------------------------------------------- seeder
-- Re-runnable: updates the catalogue entry, never a live topic.
create or replace function public.mp_seed_tier_theme(
  p_slug text, p_prompt text, p_blurb text, p_invite text,
  p_item_type text, p_labels text[], p_sort smallint, p_featured boolean default false
) returns uuid language plpgsql as $$
declare tid uuid; set_json jsonb;
begin
  select jsonb_agg(jsonb_build_object('key', public.mp_normalize(l), 'label', l) order by ord)
    into set_json
    from unnest(p_labels) with ordinality as t(l, ord);

  if set_json is null or jsonb_array_length(set_json) < 4 then
    raise exception 'theme % needs at least 4 items', p_slug;
  end if;

  -- Clear any existing feature first; the partial unique index would otherwise
  -- reject the upsert rather than move the flag.
  if p_featured then
    update public.mp_tier_themes set featured = false
     where featured and slug is distinct from p_slug;
  end if;

  insert into public.mp_tier_themes (slug, prompt, blurb, invite, item_type, item_set, status, featured, sort_order)
  values (p_slug, p_prompt, p_blurb, p_invite, p_item_type, set_json, 'approved', p_featured, p_sort)
  on conflict (slug) do update
    set prompt = excluded.prompt, blurb = excluded.blurb, invite = excluded.invite,
        item_type = excluded.item_type, item_set = excluded.item_set,
        status = excluded.status, featured = excluded.featured, sort_order = excluded.sort_order
  returning id into tid;

  -- Canonical play row, created eagerly so the client needs no lazy-create path.
  -- do-nothing on conflict: once boards exist the set is frozen.
  insert into public.mp_tier_topics (
    share_token, prompt, item_type, pool_source, draw_size, item_set,
    visibility, review_status, kind, theme_id, invite, creator_client_id, creator_label
  ) values (
    'theme_' || p_slug, p_prompt, p_item_type, 'curated',
    jsonb_array_length(set_json)::smallint, set_json,
    'public', 'approved', 'theme', tid, p_invite, null, 'Taking Court'
  ) on conflict (share_token) do nothing;

  return tid;
end $$;

alter table public.mp_tier_themes   enable row level security;
alter table public.mp_daily_schedule enable row level security;
-- intentionally no policies: service role only, same as every other mp_ table
