-- =========================================================================
-- 0015  Player notability score (applied to project ubadgdkajflkmmbmgeov on
-- 2026-07-31). Drives which players get *served* into tier/daily sets — a
-- recognizable, debatable mix of stars, memorable role players, and surviving
-- legends — while autocomplete stays fully broad (all ~4,884 players).
--
--   notability = recency_multiplier * (achievement + longevity + memorability)
--     achievement : All-Star selections + award voting shares + All-NBA/Def teams (capped)
--     longevity   : seasons + games + log(points)  -> lifts durable role players
--     memorability: rings + Hall of Fame + draft pedigree
--     recency     : 1.0 for last_season>=2000; taper to ~0.6 at 1980; ~0.2 at 1950
--
-- The edge function's tierPool() now reads mp_player_notability (order by
-- notability desc, era-overlap filter) instead of career_points thresholds.
-- After a data refresh, rebuild with: select public.mp_rebuild_notability();
-- =========================================================================

-- champion team-seasons (year -> Basketball-Reference team abbr) for the rings signal
create table if not exists public.mp_champion_seasons (season int not null, team text not null, primary key(season, team));
truncate public.mp_champion_seasons;
insert into public.mp_champion_seasons(season, team) values
(1950,'MNL'),(1951,'ROC'),(1952,'MNL'),(1953,'MNL'),(1954,'MNL'),(1955,'SYR'),(1956,'PHW'),(1957,'BOS'),(1958,'STL'),(1959,'BOS'),
(1960,'BOS'),(1961,'BOS'),(1962,'BOS'),(1963,'BOS'),(1964,'BOS'),(1965,'BOS'),(1966,'BOS'),(1967,'PHI'),(1968,'BOS'),(1969,'BOS'),
(1970,'NYK'),(1971,'MIL'),(1972,'LAL'),(1973,'NYK'),(1974,'BOS'),(1975,'GSW'),(1976,'BOS'),(1977,'POR'),(1978,'WSB'),(1979,'SEA'),
(1980,'LAL'),(1981,'BOS'),(1982,'LAL'),(1983,'PHI'),(1984,'BOS'),(1985,'LAL'),(1986,'BOS'),(1987,'LAL'),(1988,'LAL'),(1989,'DET'),
(1990,'DET'),(1991,'CHI'),(1992,'CHI'),(1993,'CHI'),(1994,'HOU'),(1995,'HOU'),(1996,'CHI'),(1997,'CHI'),(1998,'CHI'),(1999,'SAS'),
(2000,'LAL'),(2001,'LAL'),(2002,'LAL'),(2003,'SAS'),(2004,'DET'),(2005,'SAS'),(2006,'MIA'),(2007,'SAS'),(2008,'BOS'),(2009,'LAL'),
(2010,'LAL'),(2011,'DAL'),(2012,'MIA'),(2013,'MIA'),(2014,'SAS'),(2015,'GSW'),(2016,'CLE'),(2017,'GSW'),(2018,'GSW'),(2019,'TOR'),
(2020,'LAL'),(2021,'MIL'),(2022,'GSW'),(2023,'DEN'),(2024,'BOS');

-- notability table (materialized for fast serving)
create table if not exists public.mp_player_notability (
  player_key text primary key, player_name text, first_season int, last_season int,
  career_points numeric, games_played int,
  allstar_n int, award_share numeric, allnba_n int, seasons_n int, rings int, hof boolean, draft_pick int,
  achievement numeric, longevity numeric, memorability numeric, recency numeric, notability numeric
);

-- rebuildable populate (re-run after any data refresh)
create or replace function public.mp_rebuild_notability() returns int language plpgsql as $$
declare n int;
begin
  truncate public.mp_player_notability;
  insert into public.mp_player_notability
  with base as (
    select player_key, player_name, first_season, last_season, career_points, games_played
    from public.vw_trivia_player_career_summary where season_type='REGULAR'
  ),
  allstar as (select player_id, count(*) n from nba_sumitro_raw.all_star_selections where lg='NBA' group by 1),
  awards  as (select player_id, sum(nba_sumitro.to_numeric_or_null(share)) s from nba_sumitro_raw.player_award_shares group by 1),
  allnba  as (select player_id, count(*) n from nba_sumitro_raw.end_of_season_teams where lg='NBA' and (type ilike '%all-nba%' or type ilike '%all-defensive%') group by 1),
  seas    as (select player_id, count(distinct season) n from nba_sumitro_raw.player_totals where lg='NBA' group by 1),
  rings   as (select pt.player_id, count(*) n from nba_sumitro_raw.player_totals pt
               join public.mp_champion_seasons cs on cs.season=nba_sumitro.to_int_or_null(pt.season) and cs.team=pt.team
               where pt.lg='NBA' and coalesce(nba_sumitro.to_int_or_null(pt.g),0)>=20 group by 1),
  draftp  as (select player_id, min(nba_sumitro.to_int_or_null(overall_pick)) pick from nba_sumitro_raw.draft_pick_history where lg='NBA' group by 1),
  info    as (select player_id, (upper(coalesce(hof,''))='TRUE') hof from nba_sumitro_raw.player_career_info),
  comp as (
    select b.player_key, b.player_name, b.first_season, b.last_season, b.career_points, b.games_played,
      coalesce(a.n,0) allstar_n, round(coalesce(aw.s,0),2) award_share, coalesce(an.n,0) allnba_n,
      coalesce(se.n,0) seasons_n, coalesce(r.n,0) rings, coalesce(i.hof,false) hof, d.pick draft_pick,
      least( least(coalesce(a.n,0),15)*2.0 + least(coalesce(aw.s,0),8)*1.5 + least(coalesce(an.n,0),12)*1.0, 40)::numeric(6,2) achievement,
      least( least(coalesce(se.n,0),20)*0.8 + least(b.games_played/100.0,12) + least(ln(b.career_points+1)*1.5,12), 35)::numeric(6,2) longevity,
      least( least(coalesce(r.n,0),6)*3.0 + (case when coalesce(i.hof,false) then 12 else 0 end)
           + (case when d.pick=1 then 6 when d.pick<=3 then 4 when d.pick<=5 then 3 when d.pick<=10 then 1.5 else 0 end), 30)::numeric(6,2) memorability
    from base b
    left join allstar a on a.player_id=b.player_key
    left join awards aw on aw.player_id=b.player_key
    left join allnba an on an.player_id=b.player_key
    left join seas se on se.player_id=b.player_key
    left join rings r on r.player_id=b.player_key
    left join draftp d on d.player_id=b.player_key
    left join info i on i.player_id=b.player_key
  )
  select comp.*,
    (case when last_season>=2000 then 1.0
          when last_season>=1980 then 0.6+0.4*(last_season-1980)/20.0
          when last_season>=1950 then 0.2+0.4*(last_season-1950)/30.0
          else 0.15 end)::numeric(4,3) recency,
    round((case when last_season>=2000 then 1.0
          when last_season>=1980 then 0.6+0.4*(last_season-1980)/20.0
          when last_season>=1950 then 0.2+0.4*(last_season-1950)/30.0
          else 0.15 end) * (achievement+longevity+memorability), 2) notability
  from comp;
  get diagnostics n = row_count;
  return n;
end $$;

select public.mp_rebuild_notability();

create index if not exists mp_notability_score on public.mp_player_notability(notability desc);
create index if not exists mp_notability_span  on public.mp_player_notability(first_season, last_season);

alter table public.mp_champion_seasons  enable row level security;
alter table public.mp_player_notability enable row level security;
