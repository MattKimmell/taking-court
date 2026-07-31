-- =========================================================================
-- 0004  public.mp_player_metric_rank(p_query text, p_metric text)
-- Applied to project ubadgdkajflkmmbmgeov on 2026-07-21.
--
-- Given a guessed name and a category metric, returns that player's value and
-- all-time rank so a wrong guess can show "2,137 BLK, #14 all-time". Ranking
-- uses the same universe/eligibility as the seeded sheets (regular season;
-- PPG requires >= 100 games). Called by the `mp` edge function on each strike.
--
-- metric values: games_played | career_points | career_rebounds |
--                career_assists | career_blocks | ppg
-- returns: display_name, value, rank, total, unit
-- =========================================================================
create or replace function public.mp_player_metric_rank(p_query text, p_metric text)
returns table(display_name text, value numeric, rank bigint, total bigint, unit text)
language sql stable as $$
  with base as (
    select player_name,
           case p_metric
             when 'games_played'    then games_played::numeric
             when 'career_points'   then career_points
             when 'career_rebounds' then career_rebounds
             when 'career_assists'  then career_assists
             when 'career_blocks'   then career_blocks
             when 'ppg' then case when games_played >= 100
                                  then career_points / nullif(games_played,0) end
           end as val
    from public.vw_trivia_player_career_summary
    where season_type = 'REGULAR'
  ),
  filt as (select player_name, val from base where val is not null),
  ranked as (
    select player_name, val,
           rank() over (order by val desc) as rnk,
           count(*) over () as total
    from filt
  )
  select player_name,
         round(val, case when p_metric = 'ppg' then 1 else 0 end),
         rnk, total,
         case p_metric
           when 'games_played'    then 'GP'
           when 'career_points'   then 'PTS'
           when 'career_rebounds' then 'REB'
           when 'career_assists'  then 'AST'
           when 'career_blocks'   then 'BLK'
           when 'ppg'             then 'PPG'
           else '' end
  from ranked
  where public.mp_normalize(player_name) = public.mp_normalize(p_query)
  order by val desc
  limit 1;
$$;
