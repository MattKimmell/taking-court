-- =========================================================================
-- 0032  College and conference as filter dimensions.
--
-- WHY THIS DATA IS GOOD (checked before building, see FUTURE_FIXES.md):
-- nba_sumitro_raw.player_career_info.colleges is keyed by player_id — the SAME
-- Basketball-Reference id mp_player_facets uses since 0031 — so it joins 100%
-- with no name matching. The values are already the colloquial forms a fan would
-- type ("UNC", "UConn", "NC State", "LSU"), not registrar names. And 'NA' is a
-- correct no-college marker, not a gap: 387 players, and they are LeBron, Kobe,
-- Giannis, Garnett, Dirk, Jokić. Preps-to-pros and internationals are absent by
-- fact, which is what makes a naming game on this fair.
--
-- TRANSFERS COUNT AT EVERY SCHOOL. 542 players attended more than one (stored
-- comma-separated). Same deliberately-loose rule the decade lens uses: "played
-- there" beats "graduated from" for a debate.
--
-- WHY CONFERENCES AND NOT JUST COLLEGES: at the 12-recognisable floor the team
-- grid uses, only 6 of 554 colleges qualify (UNC 22, UCLA 20, Kentucky 17,
-- Duke 14, Kansas 13, Arizona 12). Six challenges is not a category. Rolled into
-- conferences it clears everywhere — ACC 74, SEC 61, Pac-12 59, Big Ten 52,
-- Big East 45, Big 12 36 — and it composes with every existing filter:
-- "ACC guards", "SEC players who won MVP", "Big East players of the 1990s".
--
-- ⚠️ CONFERENCE MEMBERSHIP MOVES, so mp_college_conferences is a CURATED
-- judgement, not a fact table. Maryland was ACC for 61 years and is now Big Ten;
-- Syracuse, Pitt and Louisville were Big East and are now ACC; the Pac-12
-- effectively dissolved in 2024. This table records the conference each school is
-- MOST ASSOCIATED WITH in NBA-fan memory, because the audience is millennial+
-- hoops fans who think of Syracuse as Big East. valid_from/valid_to are carried
-- from day one and read by nothing, so making this era-aware later is a data
-- change rather than a schema change.
-- =========================================================================

-- ---------------------------------------------------------------------------
-- The facet
-- ---------------------------------------------------------------------------
alter table public.mp_player_facets
  add column if not exists colleges text[] not null default '{}';

create index if not exists mp_facets_colleges_gin
  on public.mp_player_facets using gin (colleges);

create or replace function public.mp_rebuild_facets()
returns bigint language plpgsql as $$
declare n bigint;
begin
  truncate public.mp_player_facets;

  insert into public.mp_player_facets (
    player_key, player_name, name_key, last_name_key,
    first_season, last_season, seasons_n, games_played, career_points,
    positions, teams, decades, colleges,
    allstar_n, allnba_n, alldef_n, mvp_n, dpoy_n, roy_n, smoy_n, mip_n,
    rings, hof, draft_pick, draft_round, draft_year, notability)
  select
    v.player_key,
    v.player_name,
    public.mp_normalize(v.player_name),
    public.mp_normalize(split_part(v.player_name, ' ', -1)),
    n.first_season, n.last_season, n.seasons_n::int, n.games_played, n.career_points,
    (select coalesce(array_agg(p order by p), '{}')
       from (select unnest(array['G','F','C']) p) z
      where pci.pos ilike '%'||z.p||'%'),
    coalesce(string_to_array(replace(v.teams_played_for, ' ', ''), ','), '{}'),
    (select coalesce(array_agg(distinct (s/10)*10 order by (s/10)*10), '{}')
       from generate_series(coalesce(n.first_season, 0), coalesce(n.last_season, 0)) s
      where n.first_season is not null),
    -- colleges: split the comma-joined string, drop the 'NA' no-college marker.
    -- An empty array therefore means "did not attend college", which is a real
    -- answer about a player and not missing data.
    (select coalesce(array_agg(distinct btrim(t) order by btrim(t)), '{}')
       from unnest(string_to_array(coalesce(pci.colleges, ''), ',')) t
      where btrim(t) not in ('NA', '')),
    coalesce(n.allstar_n, 0)::int,
    coalesce(n.allnba_n, 0)::int,
    coalesce(eos.alldef, 0),
    coalesce(aw.mvp, 0), coalesce(aw.dpoy, 0), coalesce(aw.roy, 0),
    coalesce(aw.smoy, 0), coalesce(aw.mip, 0),
    coalesce(n.rings, 0)::int, coalesce(n.hof, false),
    n.draft_pick,
    nullif(regexp_replace(coalesce(dr.round, ''), '[^0-9]', '', 'g'), '')::int,
    nullif(regexp_replace(coalesce(dr.season, ''), '[^0-9]', '', 'g'), '')::int,
    n.notability
  from public.vw_trivia_player_career_summary v
  join public.mp_player_notability n on n.player_key = v.player_key
  left join nba_sumitro_raw.player_career_info pci on pci.player_id = v.player_key
  left join (
    select player_id,
           count(*) filter (where award='nba mvp')  as mvp,
           count(*) filter (where award='nba dpoy') as dpoy,
           count(*) filter (where award='nba roy')  as roy,
           count(*) filter (where award='nba smoy') as smoy,
           count(*) filter (where award='nba mip')  as mip
    from nba_sumitro_raw.player_award_shares
    where lower(coalesce(winner,'')) in ('true','t','1','yes')
    group by player_id
  ) aw on aw.player_id = v.player_key
  left join (
    select player_id, count(*)::int as alldef
    from nba_sumitro_raw.end_of_season_teams
    where type = 'All-Defense'
    group by player_id
  ) eos on eos.player_id = v.player_key
  left join (
    select player_id, min(round) as round, min(season) as season
    from nba_sumitro_raw.draft_pick_history
    where coalesce(lg,'NBA') = 'NBA'
    group by player_id
  ) dr on dr.player_id = v.player_key
  where v.season_type = 'REGULAR';

  select count(*) into n from public.mp_player_facets;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- The conference mapping (curated — see the header)
-- ---------------------------------------------------------------------------
create table if not exists public.mp_college_conferences (
  college    text primary key,
  conference text not null,
  valid_from int,          -- reserved: nothing reads these yet. They exist so
  valid_to   int           -- going era-aware later is data, not schema.
);
alter table public.mp_college_conferences enable row level security;
-- No policies: service role only, same invariant as every other mp_ table.

-- Strings are the EXACT values in player_career_info.colleges — verified against
-- the data, because a typo here silently maps nobody. Note the traps: "Pitt" not
-- Pittsburgh, "Ole Miss", "St. John's", "Miami (FL)" (the ACC one; plain
-- "Miami University" is Miami of Ohio and deliberately unmapped).
insert into public.mp_college_conferences (college, conference) values
  -- ACC
  ('UNC','ACC'),('Duke','ACC'),('NC State','ACC'),('Wake Forest','ACC'),
  ('Virginia','ACC'),('Virginia Tech','ACC'),('Georgia Tech','ACC'),('Clemson','ACC'),
  ('Florida State','ACC'),('Miami (FL)','ACC'),('Boston College','ACC'),
  ('Maryland','ACC'),          -- 61 years ACC, Big Ten only since 2014
  -- SEC
  ('Kentucky','SEC'),('Florida','SEC'),('LSU','SEC'),('Arkansas','SEC'),
  ('Alabama','SEC'),('Auburn','SEC'),('Tennessee','SEC'),('Georgia','SEC'),
  ('Vanderbilt','SEC'),('Mississippi State','SEC'),('Ole Miss','SEC'),
  ('South Carolina','SEC'),
  -- Big Ten
  ('Indiana','Big Ten'),('Michigan','Big Ten'),('Michigan State','Big Ten'),
  ('Ohio State','Big Ten'),('Illinois','Big Ten'),('Purdue','Big Ten'),
  ('Iowa','Big Ten'),('Minnesota','Big Ten'),('Wisconsin','Big Ten'),
  ('Northwestern','Big Ten'),('Penn State','Big Ten'),('Nebraska','Big Ten'),
  ('Rutgers University','Big Ten'),
  -- Big 12
  ('Kansas','Big 12'),('Kansas State','Big 12'),('Oklahoma','Big 12'),
  ('Oklahoma State','Big 12'),('Texas','Big 12'),('Texas Tech','Big 12'),
  ('Baylor','Big 12'),('Iowa State','Big 12'),('Missouri','Big 12'),
  ('Colorado','Big 12'),('Texas A&M','Big 12'),('TCU','Big 12'),
  -- Big East (the classic one — this is the call the header is about)
  ('Georgetown','Big East'),('Syracuse','Big East'),('UConn','Big East'),
  ('Villanova','Big East'),('St. John''s','Big East'),('Providence','Big East'),
  ('Seton Hall','Big East'),('Marquette','Big East'),('DePaul','Big East'),
  ('Pitt','Big East'),('Louisville','Big East'),('Notre Dame','Big East'),
  ('Cincinnati','Big East'),('West Virginia','Big East'),('Xavier','Big East'),
  ('Creighton','Big East'),
  -- Pac-12
  ('UCLA','Pac-12'),('USC','Pac-12'),('Arizona','Pac-12'),('Arizona State','Pac-12'),
  ('Oregon','Pac-12'),('Oregon State','Pac-12'),('Washington','Pac-12'),
  ('Washington State','Pac-12'),('Stanford','Pac-12'),('California','Pac-12'),
  ('University of California','Pac-12'),('Utah','Pac-12')
on conflict (college) do update set conference = excluded.conference;

comment on table public.mp_college_conferences is
  'Curated college -> conference mapping. Records the conference a school is MOST ASSOCIATED WITH for an NBA audience, not its current membership: Syracuse/Pitt/Louisville are Big East here, Maryland is ACC. valid_from/valid_to are unread placeholders for a future era-aware version.';

-- ---------------------------------------------------------------------------
-- Teach the shared predicate the two new dimensions
-- ---------------------------------------------------------------------------
-- Still ONE predicate for both the count and the generator, which is the whole
-- point of mp_facet_match — adding a dimension here gives it to the preview, the
-- relax probes, the sheet builder and the catalogue gate simultaneously.
create or replace function public.mp_facet_match(f jsonb, p_min_notability numeric default null)
returns setof public.mp_player_facets language sql stable as $$
  select pf.*
  from public.mp_player_facets pf
  where (f->>'team'     is null or pf.teams     @> array[f->>'team'])
    and (f->>'position' is null or pf.positions @> array[f->>'position'])
    and (f->>'decade'   is null or pf.decades   @> array[(f->>'decade')::int])
    and (p_min_notability is null or pf.notability >= p_min_notability)
    and (f->>'college'  is null or pf.colleges  @> array[f->>'college'])
    -- Conference matches if ANY school the player attended maps to it, which is
    -- what a transfer between conferences should do.
    and (f->>'conference' is null or exists (
           select 1 from public.mp_college_conferences cc
            where cc.conference = f->>'conference'
              and cc.college = any(pf.colleges)))
    and (f->>'award' is null or case f->>'award'
           when 'mvp'       then pf.mvp_n     > 0
           when 'dpoy'      then pf.dpoy_n    > 0
           when 'roy'       then pf.roy_n     > 0
           when 'smoy'      then pf.smoy_n    > 0
           when 'mip'       then pf.mip_n     > 0
           when 'allnba'    then pf.allnba_n  > 0
           when 'alldef'    then pf.alldef_n  > 0
           when 'allstar'   then pf.allstar_n > 0
           when 'allstar10' then pf.allstar_n >= 10
           when 'hof'       then pf.hof
           when 'ring'      then pf.rings     > 0
           else true end)
    and (f->>'draft' is null or case f->>'draft'
           when 'first'   then pf.draft_pick  = 1
           when 'top3'    then pf.draft_pick <= 3
           when 'lottery' then pf.draft_pick <= 14
           when 'round1'  then pf.draft_round = 1
           when 'round2'  then pf.draft_round = 2
           else true end);
$$;

-- ⚠️ THE DANGEROUS ONE. mp_facet_key (0030) is a sheet's identity, and it works
-- off an explicit key list. Without college/conference here, {college:"Duke"} and
-- {college:"UNC"} both canonicalise to {target:8} — identical keys — so the
-- second build would silently REUSE Duke's sheet and serve Duke's answers under a
-- UNC prompt. The unique index on source_params guarantees it, quietly.
create or replace function public.mp_facet_key(f jsonb, p_target int)
returns jsonb language sql immutable as $$
  select coalesce(
           (select jsonb_object_agg(k, f->k)
              from unnest(array['team','position','decade','award','draft',
                                'college','conference']) as k
             where f ? k and f->>k is not null),
           '{}'::jsonb)
         || jsonb_build_object('target', p_target);
$$;

-- ---------------------------------------------------------------------------
-- Preview: probe the new filters too, and name an unknown one rather than
-- reporting it as an empty combination.
-- ---------------------------------------------------------------------------
create or replace function public.mp_challenge_preview(f jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_mode   text := coalesce(f->>'mode', 'roster');
  v_want   int  := least(greatest(coalesce((f->>'target')::int, 8), 3), 12);
  v_floor  numeric := coalesce((f->>'min_notability')::numeric, 30);
  v_min_ask constant int := 3;
  v_pool int; v_known int; v_gate int; v_target int;
  v_verdict text; v_diff text := null; v_relax jsonb := null;
  v_unknown text := null;
  k text; probe jsonb; probe_n int;
  best_k text := null; best_n int := null;
  fall_k text := null; fall_n int := -1;
begin
  -- A college nobody in the data attended, or a conference nobody is mapped to,
  -- counts zero — which is indistinguishable from a real but empty combination.
  -- Saying which value we do not recognise is the difference between "no such
  -- thing" and "no such players", and the player needs to know which.
  if f->>'college' is not null and not exists (
       select 1 from public.mp_player_facets where colleges @> array[f->>'college'])
  then v_unknown := 'college';
  elsif f->>'conference' is not null and not exists (
       select 1 from public.mp_college_conferences where conference = f->>'conference')
  then v_unknown := 'conference';
  end if;

  if v_unknown is not null then
    return jsonb_build_object(
      'mode', v_mode, 'pool', 0, 'known', 0, 'gate', 0,
      'requested_target', v_want, 'target', null, 'clamped', false,
      'verdict', 'impossible', 'difficulty', null, 'relax', null,
      'unknown_filter', v_unknown, 'min_notability', v_floor, 'min_ask', v_min_ask);
  end if;

  v_pool  := public.mp_facet_count(f, null);
  v_known := public.mp_facet_count(f, v_floor);
  v_gate  := case when v_mode = 'top8' then v_pool else v_known end;
  v_target := least(v_want, greatest(v_gate - 1, v_min_ask));

  if v_gate <= v_min_ask then
    v_verdict := 'impossible';
    foreach k in array array['team','position','decade','award','draft','college','conference'] loop
      if f ? k and f->>k is not null then
        probe := f - k;
        probe_n := case when v_mode='top8' then public.mp_facet_count(probe, null)
                        else public.mp_facet_count(probe, v_floor) end;
        if probe_n > v_min_ask and (best_n is null or probe_n < best_n) then
          best_n := probe_n; best_k := k;
        end if;
        if probe_n > fall_n then fall_n := probe_n; fall_k := k; end if;
      end if;
    end loop;
    if best_k is null then best_k := fall_k; best_n := fall_n; end if;
    if best_k is not null then
      v_relax := jsonb_build_object('filter', best_k, 'would_give', best_n);
    end if;
    v_target := null;
  elsif v_gate <= v_target + 2 then
    v_verdict := 'tight';
  else
    v_verdict := 'ok';
  end if;

  if v_target is not null then
    v_diff := case
      when v_gate <= v_target + 2 then 'brutal'
      when v_gate <= v_target * 2 then 'hard'
      when v_gate <= v_target * 5 then 'normal'
      else 'easy' end;
  end if;

  return jsonb_build_object(
    'mode', v_mode, 'pool', v_pool, 'known', v_known, 'gate', v_gate,
    'requested_target', v_want, 'target', v_target,
    'clamped', v_target is not null and v_target < v_want,
    'verdict', v_verdict, 'difficulty', v_diff, 'relax', v_relax,
    'unknown_filter', null, 'min_notability', v_floor, 'min_ask', v_min_ask);
end $$;

-- ---------------------------------------------------------------------------
-- Catalogue display
-- ---------------------------------------------------------------------------
insert into public.mp_challenge_categories (slug, label, blurb, icon, sort_order) values
  ('college-hoops', 'College roots',
   'Where they came from. One-and-dones, four-year guys, and the blue bloods.', '🎓', 28)
on conflict (slug) do update
  set label = excluded.label, blurb = excluded.blurb,
      icon = excluded.icon, sort_order = excluded.sort_order;

create or replace function public.mp_facet_phrase(p_kind text, p_value text)
returns text language sql immutable as $$
  select case p_kind
    when 'award' then case p_value
      when 'mvp' then 'MVP' when 'dpoy' then 'DPOY'
      when 'roy' then 'Rookie of the Year' when 'smoy' then 'Sixth Man'
      when 'mip' then 'Most Improved' when 'allnba' then 'All-NBA'
      when 'alldef' then 'All-Defense' when 'allstar' then 'All-Stars'
      when 'allstar10' then '10+ All-Star teams' when 'hof' then 'Hall of Fame'
      when 'ring' then 'Champions' else p_value end
    when 'draft' then case p_value
      when 'first' then '1st overall' when 'top3' then 'Top-3 picks'
      when 'lottery' then 'Lottery picks' when 'round1' then '1st-round picks'
      when 'round2' then '2nd-round picks' else p_value end
    when 'position' then case p_value
      when 'G' then 'Guards' when 'F' then 'Forwards' when 'C' then 'Centers' else p_value end
    when 'team' then coalesce((select label from public.mp_team_labels where abbr = p_value), p_value)
    when 'decade' then p_value || 's'
    -- College and conference are already display-ready in the data.
    when 'college' then p_value
    when 'conference' then p_value
    else p_value end;
$$;

create or replace function public.mp_catalog_slot(f jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_cat text; v_gk text := null; v_gl text := null; v_go smallint := null;
  parts text[] := '{}';
begin
  -- Most distinctive filter picks the shelf. College sits above team because the
  -- team grid already covers every franchise exhaustively, so a college
  -- combination is the more interesting thing to have said.
  if f->>'award' is not null then v_cat := 'trophy-case';
  elsif f->>'draft' is not null then v_cat := 'draft-night';
  elsif f->>'college' is not null or f->>'conference' is not null then v_cat := 'college-hoops';
  elsif f->>'team' is not null then
    v_cat := 'team-rosters';
    v_gk := f->>'team';
    v_gl := public.mp_facet_phrase('team', v_gk);
    select group_order into v_go from public.mp_challenge_catalog
     where group_key = v_gk and group_order is not null and group_order < 999 limit 1;
    v_go := coalesce(v_go, 999);
  else v_cat := 'eras';
  end if;

  if f->>'award' is not null then parts := parts || public.mp_facet_phrase('award', f->>'award'); end if;
  if f->>'draft' is not null then parts := parts || public.mp_facet_phrase('draft', f->>'draft'); end if;
  if f->>'conference' is not null then parts := parts || public.mp_facet_phrase('conference', f->>'conference'); end if;
  if f->>'college' is not null then parts := parts || public.mp_facet_phrase('college', f->>'college'); end if;
  if f->>'position' is not null then parts := parts || public.mp_facet_phrase('position', f->>'position'); end if;
  if f->>'team' is not null and v_gk is null then parts := parts || public.mp_facet_phrase('team', f->>'team'); end if;
  if f->>'decade' is not null then parts := parts || public.mp_facet_phrase('decade', f->>'decade'); end if;

  -- The college shelf stays ungrouped for now. Grouping by conference is the
  -- obvious next axis and needs no schema change (group_key is generic), but a
  -- picker in front of five items is an extra tap for nothing.
  return jsonb_build_object(
    'category', v_cat, 'group_key', v_gk, 'group_label', v_gl, 'group_order', v_go,
    'title', coalesce(nullif(array_to_string(parts, ' · '), ''), 'Any position'));
end $$;

-- ---------------------------------------------------------------------------
-- What the client offers in its two new dropdowns
-- ---------------------------------------------------------------------------
-- Only options that could produce a game. 554 colleges in a <select> is not a
-- menu, it is a phone book — and most of them hold two players. The floor here is
-- deliberately lower than the catalogue's (5, not 12) because the preview clamps
-- thin combinations down rather than refusing them, so "Name 4 from Gonzaga" is a
-- real game the player is allowed to choose.
create or replace function public.mp_filter_options()
returns jsonb language sql stable as $$
  with per_college as (
    select c.college, count(distinct f.name_key) filter (where f.notability >= 30) known
    from public.mp_player_facets f
    cross join lateral unnest(f.colleges) c(college)
    group by 1),
  per_conf as (
    select cc.conference, count(distinct f.name_key) filter (where f.notability >= 30) known
    from public.mp_player_facets f
    join public.mp_college_conferences cc on cc.college = any(f.colleges)
    group by 1)
  select jsonb_build_object(
    'colleges', coalesce((select jsonb_agg(jsonb_build_object('v', college, 'n', known)
                                            order by known desc, college)
                            from per_college where known >= 5), '[]'::jsonb),
    'conferences', coalesce((select jsonb_agg(jsonb_build_object('v', conference, 'n', known)
                                               order by known desc)
                               from per_conf), '[]'::jsonb));
$$;

-- Populate the new column. Notability is unchanged, so only facets needs it.
select public.mp_rebuild_facets() as players_indexed;
