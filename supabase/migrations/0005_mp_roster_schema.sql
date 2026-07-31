-- =========================================================================
-- 0005  Roster-filter game type ("name N players of position P who played for
-- team T, optionally active in decade D"). Applied to project
-- ubadgdkajflkmmbmgeov on 2026-07-21. Additive; reuses mp_challenges/mp_attempts
-- via a new kind='roster'.
-- =========================================================================

alter table public.mp_challenges add column if not exists kind text not null default 'top8'
  check (kind in ('top8','roster'));
alter table public.mp_challenges add column if not exists roster_sheet_id uuid;
alter table public.mp_challenges alter column sheet_id drop not null;

create table if not exists public.mp_roster_sheets (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  difficulty text not null default 'normal' check (difficulty in ('normal','hard')),
  position text not null,                 -- Guard | Forward | Center
  team_abbr text not null,
  decade integer,                         -- e.g. 2000; null = all-time
  target smallint not null default 8 check (target between 3 and 12),
  status text not null default 'approved' check (status in ('draft','approved','retired')),
  source_params jsonb not null default '{}'::jsonb,
  play_count integer not null default 0,  -- finished attempts (pick-rate denominator)
  created_at timestamptz not null default now()
);

create table if not exists public.mp_roster_pool (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references public.mp_roster_sheets(id) on delete cascade,
  player_key text not null,
  display_name text not null,
  last_name text,
  rarity_tier text not null check (rarity_tier in ('common','uncommon','rare','deep_cut')),
  rarity_score integer,                   -- career points, the fame proxy
  games integer,
  accepted text[] not null default '{}',  -- normalized accepted aliases
  created_at timestamptz not null default now()
);
create index if not exists mp_roster_pool_sheet on public.mp_roster_pool(sheet_id);

create table if not exists public.mp_roster_picks (
  sheet_id uuid not null references public.mp_roster_sheets(id) on delete cascade,
  player_key text not null,
  picks integer not null default 0,
  primary key (sheet_id, player_key)
);

alter table public.mp_roster_sheets enable row level security;
alter table public.mp_roster_pool   enable row level security;
alter table public.mp_roster_picks  enable row level security;

-- bump a pick, return new count + sheet play count (for live pick-rate)
create or replace function public.mp_roster_bump_pick(p_sheet uuid, p_player text)
returns table(picks integer, plays integer) language plpgsql as $$
begin
  insert into public.mp_roster_picks(sheet_id, player_key, picks) values (p_sheet, p_player, 1)
  on conflict (sheet_id, player_key) do update set picks = mp_roster_picks.picks + 1
  returning mp_roster_picks.picks into picks;
  select play_count into plays from public.mp_roster_sheets where id = p_sheet;
  return next;
end $$;

create or replace function public.mp_roster_bump_play(p_sheet uuid)
returns void language sql as $$
  update public.mp_roster_sheets set play_count = play_count + 1 where id = p_sheet;
$$;

-- Build a roster category + pool from the NBA data. Rarity tier from career
-- points; accepted aliases = full name (+ last name if unique in the pool).
create or replace function public.mp_seed_roster(
  p_prompt text, p_diff text, p_position text, p_team text, p_decade integer, p_target smallint)
returns uuid language plpgsql as $$
declare sid uuid;
begin
  insert into public.mp_roster_sheets(prompt, difficulty, position, team_abbr, decade, target, status, source_params)
  values (p_prompt, p_diff, p_position, p_team, p_decade, p_target, 'approved',
          jsonb_build_object('position', p_position, 'team', p_team, 'decade', p_decade))
  returning id into sid;

  insert into public.mp_roster_pool(sheet_id, player_key, display_name, last_name, rarity_tier, rarity_score, games)
  select sid, v.player_key, v.player_name, c.last_name,
         case when v.career_points >= 15000 then 'common'
              when v.career_points >= 8000  then 'uncommon'
              when v.career_points >= 3000  then 'rare'
              else 'deep_cut' end,
         v.career_points::int, v.games_played
  from public.vw_trivia_player_career_summary v
  join nba_raw.common_player_info c on c.person_id = v.player_key
  where v.season_type = 'REGULAR'
    and c.position = p_position
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
