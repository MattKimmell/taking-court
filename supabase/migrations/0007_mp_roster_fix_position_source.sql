-- =========================================================================
-- 0007  Fix roster position source. Applied to project ubadgdkajflkmmbmgeov
-- on 2026-07-21.
--
-- Bug: 0005 sourced player position from nba_raw.common_player_info, which is
-- missing ~25% of players (incl. legends like Bird, Magic, Hakeem, and players
-- like Jarrett Jack / Shaun Livingston), and it matched position EXACTLY
-- (= 'Guard'), dropping combo positions (Guard-Forward, etc.). Result: known
-- players were marked wrong.
--
-- Fix: source position from nba_sumitro_raw.player_career_info (Basketball-
-- Reference; 100% coverage of the game's players via normalized-name match) and
-- match by position FAMILY (pos contains G / F / C), so combo players count for
-- both roles. Then re-seed all roster categories (truncate + reseed).
--
-- Verified: Warriors guards pool now includes Jarrett Jack, Shaun Livingston,
-- Curry, Klay; excludes centers (e.g. Andrew Bogut). No edge-function change
-- needed — the function reads mp_roster_pool.
-- =========================================================================
create or replace function public.mp_seed_roster(
  p_prompt text, p_diff text, p_position text, p_team text, p_decade integer, p_target smallint)
returns uuid language plpgsql as $$
declare sid uuid; poschar text;
begin
  poschar := case p_position when 'Guard' then 'G' when 'Forward' then 'F' when 'Center' then 'C' end;

  insert into public.mp_roster_sheets(prompt, difficulty, position, team_abbr, decade, target, status, source_params)
  values (p_prompt, p_diff, p_position, p_team, p_decade, p_target, 'approved',
          jsonb_build_object('position', p_position, 'team', p_team, 'decade', p_decade,
                             'pos_source', 'nba_sumitro_raw.player_career_info'))
  returning id into sid;

  insert into public.mp_roster_pool(sheet_id, player_key, display_name, last_name, rarity_tier, rarity_score, games)
  select sid, v.player_key, v.player_name, split_part(v.player_name, ' ', -1),
         case when v.career_points >= 15000 then 'common'
              when v.career_points >= 8000  then 'uncommon'
              when v.career_points >= 3000  then 'rare'
              else 'deep_cut' end,
         v.career_points::int, v.games_played
  from public.vw_trivia_player_career_summary v
  join (select public.mp_normalize(player) nk, max(pos) pos
        from nba_sumitro_raw.player_career_info group by 1) pm
    on pm.nk = public.mp_normalize(v.player_name)
  where v.season_type = 'REGULAR'
    and pm.pos ilike '%' || poschar || '%'
    and p_team = any(string_to_array(replace(v.teams_played_for, ' ', ''), ','))
    and (p_decade is null or (v.first_season <= p_decade + 9 and v.last_season >= p_decade));

  update public.mp_roster_pool p set accepted =
    case when (select count(*) from public.mp_roster_pool q
               where q.sheet_id = sid
                 and public.mp_normalize(q.last_name) = public.mp_normalize(p.last_name)) = 1
         then array[public.mp_normalize(p.display_name), public.mp_normalize(p.last_name)]
         else array[public.mp_normalize(p.display_name)] end
  where p.sheet_id = sid;

  return sid;
end $$;

truncate public.mp_roster_sheets cascade;
-- then the 8 mp_seed_roster(...) calls from 0006 were re-run.
