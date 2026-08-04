-- =========================================================================
-- 0033  Pickup gets the same browse surface as Name It, and its own builder.
--
-- Pickup was one dropdown over six hand-authored prompts — the only mode that
-- never got the browse work. Everything the filter effort built (one shared
-- predicate, generated pools, a playability gate) applies here unchanged; what
-- was missing was a way to reach it.
--
-- CATEGORIES ARE REUSED, not reinvented. mp_party_prompts points at
-- mp_challenge_categories, because a Pickup prompt and a Name It challenge are
-- the same content asked a different way. A second taxonomy over the same
-- thirty-odd subjects would be a thing to keep in sync for no gain.
--
-- WHY PARTY TARGETS ARE BIG. A roster challenge asks 3-12 of one person under a
-- three-strike limit. Pickup is a whole room shouting for five minutes with no
-- strikes, so the ask has to be ambitious or the game ends before everyone has
-- joined. The rule is `least(25, greatest(8, known))` — name the recognisable
-- ones, capped at the point a room stops making progress. Below 8 recognisable
-- names there is not enough to gather people for, and unlike the solo gate this
-- one does NOT clamp down to a tiny ask; it refuses.
-- =========================================================================

alter table public.mp_party_prompts
  add column if not exists category_slug text references public.mp_challenge_categories(slug),
  add column if not exists title    text,
  add column if not exists blurb    text,
  add column if not exists featured boolean not null default false,
  add column if not exists source_filters jsonb;

create index if not exists mp_party_prompts_browse
  on public.mp_party_prompts (category_slug, sort_order) where status = 'approved';

-- The party-shaped pool for a filter set. Shares mp_facet_match with the Name It
-- generator and the preview, so a Pickup pool and a roster pool for the same
-- filters cannot disagree about who is a valid answer. Shape matches what
-- mp_party_prompts.pool already holds, so nothing downstream changes.
create or replace function public.mp_party_pool(f jsonb)
returns jsonb language sql stable as $$
  with m as (select * from public.mp_facet_match(f, null)),
  named as (
    select m.player_key, m.player_name,
           public.mp_normalize(m.player_name) nk,
           public.mp_normalize(split_part(m.player_name, ' ', -1)) lk,
           m.notability
    from m),
  -- Last-name-only guessing, but only where the last name is unambiguous inside
  -- THIS pool. At a party nobody shouts "Hakeem Olajuwon".
  uniq as (select lk from named group by lk having count(*) = 1)
  select coalesce(jsonb_agg(jsonb_build_object(
           'player_key', n.player_key,
           'display_name', n.player_name,
           'accepted', case when u.lk is not null then jsonb_build_array(n.nk, n.lk)
                            else jsonb_build_array(n.nk) end,
           'rarity_tier', case when n.notability >= 55 then 'common'
                               when n.notability >= 38 then 'uncommon'
                               when n.notability >= 25 then 'rare'
                               else 'deep_cut' end,
           'rarity_score', coalesce(n.notability, 0))
         order by n.notability desc nulls last), '[]'::jsonb)
  from named n left join uniq u on u.lk = n.lk;
$$;

comment on function public.mp_party_pool(jsonb) is
  'Builds a Pickup answer pool from a filter set, sharing mp_facet_match with the Name It generator and the playability preview.';

create or replace function public.mp_party_target(f jsonb)
returns smallint language sql stable as $$
  select least(25, greatest(8, public.mp_facet_count(f, 30)))::smallint;
$$;

-- Pool, target and the fairness count in one call, so creating a filter-built
-- Pickup session stays a single round trip like every other create.
create or replace function public.mp_party_build(f jsonb)
returns jsonb language plpgsql stable as $$
declare v_known int; v_pool jsonb;
begin
  v_known := public.mp_facet_count(f, 30);
  if v_known < 8 then
    return jsonb_build_object('ok', false, 'reason', 'too_thin', 'known', v_known);
  end if;
  v_pool := public.mp_party_pool(f);
  return jsonb_build_object('ok', true, 'known', v_known,
                            'target', public.mp_party_target(f),
                            'pool', v_pool,
                            'pool_size', jsonb_array_length(v_pool));
end $$;

create or replace function public.mp_seed_party_prompt(
  p_slug text, p_prompt text, p_filters jsonb,
  p_category text, p_title text, p_blurb text,
  p_featured boolean default false, p_sort int default 100)
returns uuid language plpgsql as $$
declare pid uuid; v_pool jsonb; v_target smallint; v_known int;
begin
  v_known := public.mp_facet_count(p_filters, 30);
  if v_known < 8 then
    raise notice 'skipping % — only % recognisable, not worth gathering a room', p_slug, v_known;
    return null;
  end if;
  v_pool   := public.mp_party_pool(p_filters);
  v_target := public.mp_party_target(p_filters);

  insert into public.mp_party_prompts
    (slug, prompt, target, item_type, pool, status, sort_order,
     category_slug, title, blurb, featured, source_filters)
  values (p_slug, p_prompt, v_target, 'player', v_pool, 'approved', p_sort,
          p_category, p_title, p_blurb, p_featured, p_filters)
  on conflict (slug) do update
    -- Pools refresh on re-seed. Safe because a session copies the pool into
    -- answers_snapshot at create time, so editing a prompt can never change a
    -- game already in progress.
    set prompt = excluded.prompt, target = excluded.target, pool = excluded.pool,
        category_slug = excluded.category_slug, title = excluded.title,
        blurb = excluded.blurb, featured = excluded.featured,
        sort_order = excluded.sort_order, source_filters = excluded.source_filters
  returning id into pid;
  return pid;
end $$;

-- SEVERAL FEATURED, NOT ONE.
-- The single-featured index (0024) existed so scarce early participation piled
-- into one place. That reasoning is real for TIER THEMES, where a consensus gate
-- needs three boards on the SAME set before anyone gets a score — and it stays
-- there, enforced, untouched by this migration. A recall challenge and a Pickup
-- prompt have no gate, so concentrating attention buys nothing and costs the
-- shelf its most useful property at the top: variety.
drop index if exists public.mp_challenge_catalog_one_featured;
