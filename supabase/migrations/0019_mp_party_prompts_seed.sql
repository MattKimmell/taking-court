-- =========================================================================
-- 0019  Curated Pickup prompts. Pools are generated from mp_player_notability
-- at AUTHORING time and frozen as content — no random spin, so every group
-- that plays a prompt faces the identical set.
--
-- Rarity is a quartile WITHIN each pool, not an absolute notability cutoff.
-- Pools differ enormously (the Hall of Fame pool is uniformly famous; the
-- top-3-picks pool spans Kareem to Mark Workman), so a fixed threshold would
-- yield zero deep cuts in some prompts and nothing but deep cuts in others.
-- Relative tiers guarantee every prompt has 🔥 moments to shout about.
--
-- Aliases mirror mp_seed_roster (0007:49-55): full name always, plus last name
-- when it is unique within the pool. At a party nobody types "Hakeem
-- Olajuwon" — they type "Olajuwon".
--
-- Re-runnable: mp_seed_party upserts on slug.
-- =========================================================================

create or replace function public.mp_seed_party(
  p_slug text, p_prompt text, p_target smallint, p_keys text[]
) returns uuid language plpgsql as $$
declare pid uuid; pool_json jsonb;
begin
  with base as (
    select
      n.player_key,
      n.player_name,
      n.notability,
      -- strip a generational suffix before taking the last token, so
      -- "Glenn Robinson III" keys on "Robinson", not "III"
      regexp_replace(
        regexp_replace(n.player_name, '\s+(Jr\.?|Sr\.?|II|III|IV|V)$', '', 'i'),
        '^.*\s', ''
      ) as last_name
    from public.mp_player_notability n
    where n.player_key = any(p_keys)
  ),
  tiered as (
    select b.*,
           ntile(4) over (order by b.notability desc) as q
    from base b
  ),
  aliased as (
    select t.*,
      case
        when count(*) over (partition by public.mp_normalize(t.last_name)) = 1
          then array[public.mp_normalize(t.player_name), public.mp_normalize(t.last_name)]
        else array[public.mp_normalize(t.player_name)]
      end as accepted
    from tiered t
  )
  select jsonb_agg(jsonb_build_object(
           'player_key',   a.player_key,
           'display_name', a.player_name,
           'accepted',     a.accepted,
           'rarity_tier',  case a.q when 1 then 'common' when 2 then 'uncommon'
                                    when 3 then 'rare'   else 'deep_cut' end,
           'rarity_score', round(a.notability::numeric, 1)
         ) order by a.notability desc)
    into pool_json
  from aliased a;

  if pool_json is null or jsonb_array_length(pool_json) < p_target then
    raise exception 'pool for % has % entries, below target %',
      p_slug, coalesce(jsonb_array_length(pool_json), 0), p_target;
  end if;

  insert into public.mp_party_prompts (slug, prompt, target, item_type, pool, status)
  values (p_slug, p_prompt, p_target, 'player', pool_json, 'approved')
  on conflict (slug) do update
    set prompt = excluded.prompt,
        target = excluded.target,
        pool   = excluded.pool,
        status = excluded.status
  returning id into pid;

  return pid;
end $$;

-- Seeds, easy -> hard, so a group can run several rounds in one sitting.
-- sort_order is set after insert since mp_seed_party doesn't take it.

select public.mp_seed_party('points-20k', 'Players with 20,000+ career points', 20::smallint,
  array(select player_key from public.mp_player_notability where career_points >= 20000));

select public.mp_seed_party('allstar-10', 'Players with 10+ All-Star selections', 15::smallint,
  array(select player_key from public.mp_player_notability where allstar_n >= 10));

select public.mp_seed_party('pick-1', 'Players taken #1 overall in the NBA draft', 20::smallint,
  array(select player_key from public.mp_player_notability where draft_pick = 1));

select public.mp_seed_party('rings-3', 'Players with 3 or more championship rings', 20::smallint,
  array(select player_key from public.mp_player_notability where rings >= 3));

select public.mp_seed_party('top-3-picks', 'Players drafted in the top 3', 25::smallint,
  array(select player_key from public.mp_player_notability where draft_pick between 1 and 3));

select public.mp_seed_party('hall-of-fame', 'Hall of Famers', 25::smallint,
  array(select player_key from public.mp_player_notability where hof));

update public.mp_party_prompts set sort_order = v.ord
from (values ('points-20k',10),('allstar-10',20),('pick-1',30),
             ('rings-3',40),('top-3-picks',50),('hall-of-fame',60)) as v(slug, ord)
where mp_party_prompts.slug = v.slug;
