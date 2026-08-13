-- 0046 · Scope a leader metric to the team and decade it is filtered by
--
-- Correction to 20260813120000. That migration ranked by the CAREER total on
-- mp_player_facets, which is right for a league-wide board and a lie for any
-- board that scopes by team or decade. Caught by reading the first generated
-- board out loud:
--
--   "Bulls points" → Michael Jordan 32,292 · DeMar DeRozan 26,241 ·
--                    Robert Parish 23,334 · Dwyane Wade 23,165 …
--
-- Parish played ONE season in Chicago and scored 161 points there. Jordan's
-- 32,292 includes Washington. Every name was a player who had worn the jersey,
-- and not one number was a Bulls number.
--
-- ⚠️ This is the same defect 0038 fixed for awards — the facets row says "how
-- many" and "which teams" as two INDEPENDENT facts, so combining them invents
-- a claim the data never made. Shaquille O'Neal won ROY with Orlando and
-- reached the Lakers four years later; Robert Parish scored 23,334 points and
-- 161 of them as a Bull. Same shape of bug, same shape of fix: one row per
-- scope, in a side table. NOT parallel arrays on facets — those cannot make
-- the scopes agree with each other.
--
-- Grain is (player_key, team, decade), which covers all four cases with one
-- table: team only sums across decades, decade only sums across teams, both
-- takes the row, neither is the career total.
--
-- Verified before shipping: summing every row per player reproduces
-- career_points / assists / rebounds / blocks / games_played EXACTLY for all
-- 4,884 players (0 mismatches on all five), so the unscoped path is provably
-- unchanged by routing through this table.
--
-- ⚠️ `NA` in the source means "not recorded in that era", not zero: blocks
-- begin in 1974 (3,566 NA rows, all earlier) and rebounds in 1951 (269 NA
-- rows, all earlier). Points, assists and games have none. NA sums as zero,
-- which is what makes an out-of-era board fall to zero and get refused by the
-- `val > 0` guard rather than served as a board of nobodies.

begin;

create table if not exists public.mp_player_stat_totals (
  player_key text    not null,
  team       text    not null,
  decade     integer not null,
  games      numeric not null default 0,
  points     numeric not null default 0,
  assists    numeric not null default 0,
  rebounds   numeric not null default 0,
  blocks     numeric not null default 0,
  primary key (player_key, team, decade)
);

-- Same rule as every other mp_* table: deny-all, only the edge function's
-- service role reads it.
alter table public.mp_player_stat_totals enable row level security;

comment on table public.mp_player_stat_totals is
  'Per (player, franchise, decade) stat totals. Exists because a career total is '
  'a LIE when the filter scopes by team or decade: Robert Parish has 23,334 career '
  'points and 161 of them as a Bull. Same defect 0038 fixed for awards, same shape '
  'of fix: one row per scope, never parallel arrays on facets. NA in the source '
  'means "not recorded that era" (blocks pre-1974, rebounds pre-1951) and sums as '
  'zero, so an out-of-era board correctly falls to zero and is refused.';

create or replace function public.mp_rebuild_stat_totals()
 returns bigint language plpgsql
as $function$
declare n bigint;
begin
  truncate public.mp_player_stat_totals;
  insert into public.mp_player_stat_totals
    (player_key, team, decade, games, points, assists, rebounds, blocks)
  select t.player_id,
         t.team,
         -- Filed under the year the season ENDS, matching
         -- mp_player_award_seasons.decade. A title and an MVP won in June 1990
         -- have to land in the same decade or the two disagree about that spring.
         (t.season::int / 10) * 10,
         sum(case when btrim(t.g)   ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(t.g)::numeric   else 0 end),
         sum(case when btrim(t.pts) ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(t.pts)::numeric else 0 end),
         sum(case when btrim(t.ast) ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(t.ast)::numeric else 0 end),
         sum(case when btrim(t.trb) ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(t.trb)::numeric else 0 end),
         sum(case when btrim(t.blk) ~ '^-?[0-9]+(\.[0-9]+)?$' then btrim(t.blk)::numeric else 0 end)
  from nba_sumitro_raw.player_totals t
  where t.lg = 'NBA'
    -- The combined multi-team lines would double-count a traded season, exactly
    -- as 0038 excludes them when resolving an award's club.
    and t.team not in ('NTM','2TM','3TM','4TM','5TM')
    and t.season ~ '^[0-9]+$'
  group by 1, 2, 3;
  select count(*) into n from public.mp_player_stat_totals;
  return n;
end $function$;

select public.mp_rebuild_stat_totals();

-- Both callers below read the metric through the SAME lateral, for the same
-- reason 0028 gives: separate copies would let the gate promise a board the
-- generator does not produce.
create or replace function public.mp_facet_ranked_pool(f jsonb, p_target integer)
 returns table (
   player_key text, player_name text, games_played integer,
   notability numeric, pool_rank integer, metric_value numeric)
 language sql stable
as $function$
  select m.player_key, m.player_name, m.games_played, m.notability,
         (row_number() over (order by v.val desc, m.player_key))::int,
         v.val
  from public.mp_facet_match(f, null) m
  join lateral (
    select sum(case f->>'metric'
                 when 'points'   then t.points
                 when 'assists'  then t.assists
                 when 'rebounds' then t.rebounds
                 when 'blocks'   then t.blocks
                 when 'games'    then t.games
               end) as val
    from public.mp_player_stat_totals t
    where t.player_key = m.player_key
      and (f->>'team'   is null or t.team   = f->>'team')
      and (f->>'decade' is null or t.decade = (f->>'decade')::int)
  ) v on true
  where public.mp_is_metric(f->>'metric')
    and v.val > 0
  order by 5
  limit greatest(coalesce(p_target, 0), 0);
$function$;

create or replace function public.mp_facet_metric_count(f jsonb)
 returns integer language sql stable
as $function$
  select count(*)::int
  from public.mp_facet_match(f, null) m
  join lateral (
    select sum(case f->>'metric'
                 when 'points'   then t.points
                 when 'assists'  then t.assists
                 when 'rebounds' then t.rebounds
                 when 'blocks'   then t.blocks
                 when 'games'    then t.games
               end) as val
    from public.mp_player_stat_totals t
    where t.player_key = m.player_key
      and (f->>'team'   is null or t.team   = f->>'team')
      and (f->>'decade' is null or t.decade = (f->>'decade')::int)
  ) v on true
  where public.mp_is_metric(f->>'metric')
    and v.val > 0;
$function$;

commit;
