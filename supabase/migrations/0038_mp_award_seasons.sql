-- 0038 — An award belongs to a SEASON, not to a career.
--
-- mp_player_facets carries award COUNTS (mvp_n, roy_n, …) and a flat teams[] /
-- decades[], and mp_facet_match tested them independently. So "Lakers players
-- who won Rookie of the Year" meant "played for the Lakers at some point AND won
-- ROY at some point" — which admits Shaquille O'Neal, who won ROY with Orlando
-- in 1993 and only reached the Lakers in 1997. He is a right answer to the
-- Magic version of that question and a wrong answer to the Lakers version, and
-- the app could not tell the difference.
--
-- ⚠️ The identical defect applies to DECADE, and it was already live: the
-- shipped "Sixth Man · 2010s" sheet accepted Manu Ginóbili (2008), Jason Terry
-- (2009), Montrezl Harrell (2020) and Malcolm Brogdon (2023) — every one of them
-- a Sixth Man winner who simply also played during the 2010s. Fixing team
-- without decade would leave half the bug in place.
--
-- The fix is one table of award WINS, each stamped with the season, the team the
-- player was on that season, and the decade. mp_facet_match then requires a
-- single win that satisfies every context filter at once.
--
-- Why a side table rather than another array on mp_player_facets: the contexts
-- have to agree with EACH OTHER, not just with the player. Two arrays
-- (award_teams, award_decades) would let "Bucks MVPs of the 1980s" match Kareem,
-- whose mvp:MIL tokens are all 1970s and whose mvp:1980 token is a Laker one.
-- One row per win is the only shape that cannot make that mistake.

create table if not exists public.mp_player_award_seasons (
  player_key text    not null,
  award      text    not null,
  season     integer not null,
  team       text    not null,
  decade     integer not null,
  primary key (player_key, award, season, team)
);
create index if not exists mp_player_award_seasons_lookup
  on public.mp_player_award_seasons (player_key, award);
create index if not exists mp_player_award_seasons_team
  on public.mp_player_award_seasons (award, team);

alter table public.mp_player_award_seasons enable row level security;
-- intentionally no policies: service role only, same as every other mp_ table

-- ---------------------------------------------------------------------------
create or replace function public.mp_rebuild_award_seasons()
returns bigint language plpgsql as $$
declare n bigint;
begin
  truncate public.mp_player_award_seasons;

  -- One row per (player, season, real team). A traded player has a row per club
  -- plus a combined 2TM/3TM line in the source; the combined line is not a team
  -- anyone played for, so it is excluded and the real clubs are kept.
  --
  -- That means a mid-season trade credits the award to BOTH clubs. It is the
  -- generous reading, and it is close to free: across every major award ever
  -- won, exactly one season is ambiguous (a single DPOY), plus 9 All-NBA and 6
  -- All-Defense selections out of 1,503. Refusing a defensible answer costs a
  -- player the sheet; accepting one nobody disputes costs nothing.
  with real_teams as (
    select player_id, season::int as season, team
    from nba_sumitro_raw.player_totals
    where lg = 'NBA' and team !~ '^[0-9]+TM$'
  ),
  wins as (
    -- The five voted awards. player_award_shares has no team column.
    select w.player_id, w.season::int as season, rt.team,
           case w.award when 'nba mvp'  then 'mvp'  when 'nba dpoy' then 'dpoy'
                        when 'nba roy'  then 'roy'  when 'nba smoy' then 'smoy'
                        when 'nba mip'  then 'mip'  end as award
    from nba_sumitro_raw.player_award_shares w
    join real_teams rt on rt.player_id = w.player_id and rt.season = w.season::int
    where lower(coalesce(w.winner,'')) in ('true','t','1','yes')
      and w.award in ('nba mvp','nba dpoy','nba roy','nba smoy','nba mip')

    union all
    -- All-NBA / All-Defense. Also team-less at source.
    select e.player_id, e.season::int, rt.team,
           case e.type when 'All-NBA' then 'allnba' when 'All-Defense' then 'alldef' end
    from nba_sumitro_raw.end_of_season_teams e
    join real_teams rt on rt.player_id = e.player_id and rt.season = e.season::int
    where e.type in ('All-NBA','All-Defense')

    union all
    -- ⚠️ all_star_selections HAS a `team` column, but it holds the exhibition
    -- squad — 'East', 'West', 'Team LeBron' — not the club. The club has to come
    -- from the season join like everything else.
    select a.player_id, a.season::int, rt.team, 'allstar'
    from nba_sumitro_raw.all_star_selections a
    join real_teams rt on rt.player_id = a.player_id and rt.season = a.season::int

    union all
    -- A ring is already a team-season fact; it just needs the roster.
    select rt.player_id, cs.season, cs.team, 'ring'
    from public.mp_champion_seasons cs
    join real_teams rt on rt.season = cs.season and rt.team = cs.team
  )
  insert into public.mp_player_award_seasons (player_key, award, season, team, decade)
  select distinct public.mp_canonical_player_key(player_id), award, season, team, (season/10)*10
  from wins
  where award is not null and team is not null and season is not null;

  select count(*) into n from public.mp_player_award_seasons;
  return n;
end $$;

select public.mp_rebuild_award_seasons();

-- ---------------------------------------------------------------------------
-- The predicate. Shared by mp_challenge_preview, mp_build_filtered_roster and
-- mp_party_build (0028's one-predicate-two-callers rule), so all three tighten
-- together and a preview can never promise a count the sheet does not hold.
create or replace function public.mp_facet_match(f jsonb, p_min_notability numeric default null)
returns setof public.mp_player_facets
language sql stable as $$
  select pf.*
  from public.mp_player_facets pf
  where (f->>'team'     is null or pf.teams     @> array[f->>'team'])
    and (f->>'position' is null or pf.positions @> array[f->>'position'])
    and (f->>'decade'   is null or pf.decades   @> array[(f->>'decade')::int])
    and (p_min_notability is null or pf.notability >= p_min_notability)
    and (f->>'college'  is null or pf.colleges  @> array[f->>'college'])
    and (f->>'conference' is null or exists (
           select 1 from public.mp_college_conferences cc
            where cc.conference = f->>'conference'
              and cc.college = any(pf.colleges)))
    and (f->>'award' is null or
      case
        -- Career honours. "Lakers players in the Hall of Fame" means played
        -- there and got in — there is no season to pin it to. Likewise a
        -- 10-All-Star career: the milestone IS the career total, so scoping it
        -- to one team would answer a different question.
        when f->>'award' = 'hof'       then pf.hof
        when f->>'award' = 'allstar10' then pf.allstar_n >= 10
        -- Season awards with no context filter: the count is equivalent and
        -- cheaper, so the common case does not pay for the join.
        when f->>'team' is null and f->>'decade' is null then
          case f->>'award'
            when 'mvp'     then pf.mvp_n     > 0
            when 'dpoy'    then pf.dpoy_n    > 0
            when 'roy'     then pf.roy_n     > 0
            when 'smoy'    then pf.smoy_n    > 0
            when 'mip'     then pf.mip_n     > 0
            when 'allnba'  then pf.allnba_n  > 0
            when 'alldef'  then pf.alldef_n  > 0
            when 'allstar' then pf.allstar_n > 0
            when 'ring'    then pf.rings     > 0
            else true end
        -- Season awards WITH a team and/or a decade: one single win has to
        -- satisfy all of it. Testing them separately is what let Shaq answer
        -- "Lakers Rookie of the Year".
        else exists (
          select 1 from public.mp_player_award_seasons aw
           where aw.player_key = pf.player_key
             and aw.award      = f->>'award'
             and (f->>'team'   is null or aw.team   = f->>'team')
             and (f->>'decade' is null or aw.decade = (f->>'decade')::int))
      end)
    and (f->>'draft' is null or case f->>'draft'
           when 'first'   then pf.draft_pick  = 1
           when 'top3'    then pf.draft_pick <= 3
           when 'lottery' then pf.draft_pick <= 14
           when 'round1'  then pf.draft_round = 1
           when 'round2'  then pf.draft_round = 2
           else true end);
$$;

-- Rebuild order for anyone regenerating from scratch:
--   select public.mp_rebuild_notability();
--   select public.mp_rebuild_facets();        -- reads notability
--   select public.mp_rebuild_award_seasons(); -- independent of both
