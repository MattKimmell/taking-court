-- One service-only player lookup supports inline correct/false explanations for
-- every roster Challenge facet. It reads existing player facets and raw NBA
-- history; it does not add a context table or expose the answer pool.
create or replace function public.mp_roster_guess_context(
  p_query text,
  p_player_key text,
  p_filters jsonb
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  player public.mp_player_facets%rowtype;
  team_ranges jsonb := '[]'::jsonb;
  conference_rows jsonb := '[]'::jsonb;
  draft_row jsonb := null;
  team_filter text := nullif(p_filters->>'team', '');
begin
  if nullif(p_player_key, '') is not null then
    select * into player
    from public.mp_player_facets f
    where f.player_key = p_player_key
    limit 1;
  end if;

  if player.player_key is null and nullif(public.mp_normalize(coalesce(p_query, '')), '') is not null then
    select * into player
    from public.mp_player_facets f
    where f.name_key = public.mp_normalize(p_query)
    limit 1;
  end if;

  -- Accept a surname only when it identifies exactly one player globally.
  -- Correct pool-local aliases always arrive with p_player_key above.
  if player.player_key is null and nullif(public.mp_normalize(coalesce(p_query, '')), '') is not null then
    if (select count(*) = 1 from public.mp_player_facets f
        where f.last_name_key = public.mp_normalize(p_query)) then
      select * into player
      from public.mp_player_facets f
      where f.last_name_key = public.mp_normalize(p_query)
      limit 1;
    end if;
  end if;

  if player.player_key is null then
    return jsonb_build_object('known_player', false);
  end if;

  if team_filter is not null then
    with seasons as (
      select distinct pt.season::int as season
      from nba_sumitro_raw.player_totals pt
      where pt.player_id = player.player_key
        and pt.lg = 'NBA'
        and pt.team = team_filter
        and pt.team !~ '^[0-9]+TM$'
    ), grouped as (
      select season, season - row_number() over (order by season)::int as grp
      from seasons
    ), collapsed as (
      select min(season) as from_season, max(season) as to_season
      from grouped
      group by grp
      order by min(season)
    )
    select coalesce(jsonb_agg(jsonb_build_object('from', from_season, 'to', to_season)), '[]'::jsonb)
      into team_ranges
    from collapsed;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'college', cc.college,
      'conference', cc.conference
    ) order by cc.college), '[]'::jsonb)
    into conference_rows
  from public.mp_college_conferences cc
  where cc.college = any(player.colleges);

  select jsonb_build_object(
      'year', nullif(regexp_replace(coalesce(d.season, ''), '[^0-9]', '', 'g'), '')::int,
      'pick', nullif(regexp_replace(coalesce(d.overall_pick, ''), '[^0-9]', '', 'g'), '')::int,
      'round', nullif(regexp_replace(coalesce(d.round, ''), '[^0-9]', '', 'g'), '')::int,
      'team', nullif(d.tm, '')
    )
    into draft_row
  from nba_sumitro_raw.draft_pick_history d
  where d.player_id = player.player_key
    and coalesce(d.lg, 'NBA') = 'NBA'
  order by nullif(regexp_replace(coalesce(d.season, ''), '[^0-9]', '', 'g'), '')::int nulls last
  limit 1;

  return jsonb_build_object(
    'known_player', true,
    'player_key', player.player_key,
    'player_name', player.player_name,
    'first_season', player.first_season,
    'last_season', player.last_season,
    'positions', to_jsonb(player.positions),
    'teams', to_jsonb(player.teams),
    'decades', to_jsonb(player.decades),
    'colleges', to_jsonb(player.colleges),
    'conferences', conference_rows,
    'team_ranges', team_ranges,
    'allstar_n', player.allstar_n,
    'allnba_n', player.allnba_n,
    'alldef_n', player.alldef_n,
    'mvp_n', player.mvp_n,
    'dpoy_n', player.dpoy_n,
    'roy_n', player.roy_n,
    'smoy_n', player.smoy_n,
    'mip_n', player.mip_n,
    'rings', player.rings,
    'hof', player.hof,
    'draft', draft_row
  );
end;
$$;

revoke all on function public.mp_roster_guess_context(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.mp_roster_guess_context(text, text, jsonb)
  to service_role;

comment on function public.mp_roster_guess_context(text, text, jsonb) is
  'Service-role-only facts for the submitted roster guess across team, position, decade, award, draft, college, and conference filters. Never returns another valid player or an answer pool.';
