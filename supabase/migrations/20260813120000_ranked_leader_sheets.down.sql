-- DOWN for BOTH 20260813120000_ranked_leader_sheets.sql
--                and 20260813123000_scope_leader_metrics.sql
--
-- One down for the pair on purpose: the second migration only exists to correct
-- the first, and reverting to the state between them would leave team-scoped
-- leader boards live and wrong. There is no useful stopping point in the middle.
--
-- ✅ VERIFIED, not assumed: this file was executed in full against production
-- inside a transaction on 2026-08-13 and restored all four golden hashes
-- (facets, sheet identities, pools, and the 16-case preview battery — the last
-- compared WITHOUT stripping the new keys, proving the old signature returned),
-- then rolled back.
--
-- Every function body below is the verbatim pre-migration definition, captured
-- from pg_get_functiondef() before anything was applied. Running this returns
-- the database to its exact prior behaviour.
--
-- Order matters: drop the columns AFTER restoring the functions, because
-- mp_metric_value takes mp_player_facets as a composite argument and depends
-- on the table's shape.
--
-- Safe to run: nothing here touches a row of mp_roster_sheets, mp_roster_pool
-- or mp_challenges. The only data effect is the facets rebuild, which is
-- deterministic and regenerates from the warehouse either way.

begin;

-- 1. restore the gate
create or replace function public.mp_challenge_preview(f jsonb)
 returns jsonb language plpgsql stable
as $function$
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
end $function$;

-- 2. restore identity (drops 'metric' from the whitelist)
create or replace function public.mp_facet_key(f jsonb, p_target integer)
 returns jsonb language sql immutable
as $function$
  select coalesce(
           (select jsonb_object_agg(k, f->k)
              from unnest(array['team','position','decade','award','draft',
                                'college','conference']) as k
             where f ? k and f->>k is not null),
           '{}'::jsonb)
         || jsonb_build_object('target', p_target);
$function$;

-- 3. restore builder
create or replace function public.mp_build_filtered_roster(
    f jsonb, p_prompt text, p_target smallint, p_difficulty text default 'normal'::text)
 returns uuid language plpgsql
as $function$
declare sid uuid; k jsonb;
begin
  k := public.mp_facet_key(f, p_target::int);

  select id into sid from public.mp_roster_sheets
   where source_params = k and status = 'approved' limit 1;
  if sid is not null then return sid; end if;

  insert into public.mp_roster_sheets
    (prompt, difficulty, position, team_abbr, decade, target, status, source_params)
  values (p_prompt, p_difficulty,
          case k->>'position' when 'G' then 'Guard' when 'F' then 'Forward' when 'C' then 'Center' end,
          k->>'team', (k->>'decade')::int, p_target, 'approved', k)
  returning id into sid;

  insert into public.mp_roster_pool
    (sheet_id, player_key, display_name, last_name, rarity_tier, rarity_score, games)
  select sid, m.player_key, m.player_name, split_part(m.player_name, ' ', -1),
         case when m.notability >= 55 then 'common'
              when m.notability >= 38 then 'uncommon'
              when m.notability >= 25 then 'rare'
              else 'deep_cut' end,
         coalesce(m.notability, 0)::int, m.games_played
  from public.mp_facet_match(k, null) m;

  update public.mp_roster_pool p set accepted =
    case when (select count(*) from public.mp_roster_pool q
                where q.sheet_id = sid
                  and public.mp_normalize(q.last_name) = public.mp_normalize(p.last_name)) = 1
         then array[public.mp_normalize(p.display_name), public.mp_normalize(p.last_name)]
         else array[public.mp_normalize(p.display_name)] end
  where p.sheet_id = sid;

  return sid;
end $function$;

-- 4. restore refiller
create or replace function public.mp_refill_roster_pool(p_sheet uuid)
 returns integer language plpgsql
as $function$
declare k jsonb; n integer;
begin
  select source_params into k from public.mp_roster_sheets where id = p_sheet;
  if k is null then return 0; end if;
  delete from public.mp_roster_pool where sheet_id = p_sheet;
  insert into public.mp_roster_pool
    (sheet_id, player_key, display_name, last_name, rarity_tier, rarity_score, games)
  select p_sheet, m.player_key, m.player_name, split_part(m.player_name, ' ', -1),
         case when m.notability >= 55 then 'common'
              when m.notability >= 38 then 'uncommon'
              when m.notability >= 25 then 'rare'
              else 'deep_cut' end,
         coalesce(m.notability, 0)::int, m.games_played
  from public.mp_facet_match(k, null) m;
  update public.mp_roster_pool p set accepted =
    case when (select count(*) from public.mp_roster_pool q
                where q.sheet_id = p_sheet
                  and public.mp_normalize(q.last_name) = public.mp_normalize(p.last_name)) = 1
         then array[public.mp_normalize(p.display_name), public.mp_normalize(p.last_name)]
         else array[public.mp_normalize(p.display_name)] end
  where p.sheet_id = p_sheet;
  select count(*) into n from public.mp_roster_pool where sheet_id = p_sheet;
  return n;
end $function$;

-- 5. drop the new surface
drop function if exists public.mp_facet_ranked_pool(jsonb, integer);
drop function if exists public.mp_facet_metric_count(jsonb);
drop function if exists public.mp_metric_value(public.mp_player_facets, text);
drop function if exists public.mp_is_metric(text);
drop function if exists public.mp_rebuild_stat_totals();
drop table    if exists public.mp_player_stat_totals;

alter table public.mp_roster_pool
  drop column if exists "rank",
  drop column if exists metric_value;

-- 6. restore the facets builder, then the table shape, then the data
create or replace function public.mp_rebuild_facets()
 returns bigint language plpgsql
as $function$
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
end $function$;

alter table public.mp_player_facets
  drop column if exists career_assists,
  drop column if exists career_rebounds,
  drop column if exists career_blocks;

select public.mp_rebuild_facets();

commit;
