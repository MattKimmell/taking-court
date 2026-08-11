-- Daily Take rows can now represent immutable partial progress. Only a row with
-- completed_at contributes to streaks, sharing, Crew state, or Take completion.
alter table public.mp_court_take_locks
  add column if not exists completed_at timestamptz;

update public.mp_court_take_locks
set completed_at = coalesce(updated_at, created_at)
where completed_at is null
  and (select count(*) from jsonb_object_keys(answers)) = 3;

create index if not exists mp_court_take_locks_completed_day
  on public.mp_court_take_locks(day_id, completed_at)
  where completed_at is not null;

comment on column public.mp_court_take_locks.completed_at is
  'Null while one or two Daily Take items are locked; set once all three valid immutable answers exist.';

-- Resolve context for the submitted guess only. This deliberately never
-- returns the Daily answer pool or a different valid answer.
create or replace function public.mp_daily_guess_context(
  p_query text,
  p_player_key text,
  p_axis text,
  p_value text,
  p_position text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  player public.mp_player_facets%rowtype;
  ranges jsonb := '[]'::jsonb;
  axis_ok boolean := false;
  position_ok boolean := false;
  failed text;
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

  -- A surname is accepted here only when it is globally unambiguous. Correct
  -- roster hits pass their canonical key above, so pool-local aliases remain
  -- accurate without broadening wrong-guess identity resolution.
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
    return jsonb_build_object(
      'known_player', false,
      'filter_failed', 'unknown',
      'axis', p_axis,
      'value', p_value,
      'required_position', p_position
    );
  end if;

  if p_axis = 'team' then
    with seasons as (
      select distinct pt.season::int as season
      from nba_sumitro_raw.player_totals pt
      where pt.player_id = player.player_key
        and pt.lg = 'NBA'
        and pt.team = p_value
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
      into ranges
    from collapsed;
    axis_ok := jsonb_array_length(ranges) > 0;
  elsif p_axis = 'college' then
    axis_ok := player.colleges @> array[p_value];
  end if;

  position_ok := player.positions @> array[p_position];
  failed := case when not axis_ok then p_axis when not position_ok then 'position' else null end;

  return jsonb_build_object(
    'known_player', true,
    'player_key', player.player_key,
    'display_name', player.player_name,
    'positions', to_jsonb(player.positions),
    'colleges', to_jsonb(player.colleges),
    'team_ranges', ranges,
    'axis', p_axis,
    'value', p_value,
    'required_position', p_position,
    'axis_match', axis_ok,
    'position_match', position_ok,
    'filter_failed', failed
  );
end;
$$;

revoke all on function public.mp_daily_guess_context(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.mp_daily_guess_context(text, text, text, text, text)
  to service_role;

comment on function public.mp_daily_guess_context(text, text, text, text, text) is
  'Service-role-only context for the submitted Daily roster guess. Never reveals another valid player or the answer pool.';
