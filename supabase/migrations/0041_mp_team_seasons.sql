-- =========================================================================
-- 0041 — A team is a season, not a franchise.
--
-- Ranking franchises all-time collapses sixty years into one word. "Bulls vs
-- Cavs" has one answer everybody already agrees on; "96 Bulls vs 16 Cavs" is
-- the argument people actually have. Migration 0040 fixed this for subjective
-- lists (entry_type 'team_season'); this brings tier lists, the curated themes
-- and the Daily onto the same footing.
--
-- What lands here:
--   1. public.mp_team_seasons — one row per NBA team-season with a notability
--      score, so tier pools can DRAW specific teams instead of franchises.
--   2. item_type 'team_season' on mp_tier_topics and mp_tier_themes.
--   3. The 2025 champion, which was missing and made OKC read as a team that
--      never won (see the warning on mp_rebuild_team_seasons below).
--   4. Content: the all-time "Franchise tiers" theme retires, two
--      year-specific themes ship, and "Greatest single seasons" is retyped.
--
-- The two team pool_sources ('all_teams', 'champion_teams') are deliberately
-- LEFT WORKING. Topics created before today store one in pool_source and
-- tier_reroll reads it back; removing them would break reroll on shipped
-- boards. They simply stop being offered.
-- =========================================================================

-- ---------------------------------------------------------------- 1. champions
-- The Thunder won the 2025 title. Without this row mp_rebuild_team_seasons
-- scores 2025 OKC (68-14) as the best team that never won anything, and
-- mp_rebuild_notability quietly denies a ring to that whole roster.
insert into public.mp_champion_seasons (season, team) values (2025, 'OKC')
  on conflict do nothing;

-- mp_champion_seasons is read by three derivations, so adding a row obliges all
-- three. Documented order: notability first, facets reads notability, award
-- seasons reads neither. Skipping them would leave a ring visible to the team
-- pool and invisible to the player pool.
select public.mp_rebuild_notability();
select public.mp_rebuild_facets();
select public.mp_rebuild_award_seasons();

-- ---------------------------------------------------------------- 2. the table
create table if not exists public.mp_team_seasons (
  season     integer not null,
  abbrev     text    not null,
  franchise  text    not null,          -- the name it wore THAT season ("Seattle SuperSonics")
  label      text    not null,          -- '1995-96 Chicago Bulls' — what a player sees
  key        text    not null,          -- public.mp_normalize(label); tier_save validates on this
  wins       integer not null,
  losses     integer not null,
  win_pct    numeric,
  srs        numeric,                   -- simple rating system: margin of victory, schedule-adjusted
  champion   boolean not null default false,
  playoffs   boolean not null default false,
  decade     integer not null,
  notability numeric not null default 0,
  primary key (season, abbrev)
);
-- One row per label: the pool serves labels, and two rows sharing one would be
-- an unanswerable slot in exactly the way two same-named players are.
create unique index if not exists mp_team_seasons_key on public.mp_team_seasons (key);
create index if not exists mp_team_seasons_notability on public.mp_team_seasons (notability desc);
create index if not exists mp_team_seasons_decade on public.mp_team_seasons (decade, notability desc);

alter table public.mp_team_seasons enable row level security;
-- intentionally no policies: service role only, same as every other mp_ table

-- ---------------------------------------------------------------- 3. the rebuild
-- Mirrors mp_rebuild_notability's shape: store EVERY team-season with a score,
-- and let the serving query pick a floor. A truncated table would have to be
-- rebuilt to change what counts as notable.
create or replace function public.mp_rebuild_team_seasons() returns integer
language plpgsql as $$
declare n integer;
begin
  delete from public.mp_team_seasons;

  insert into public.mp_team_seasons
    (season, abbrev, franchise, label, key, wins, losses, win_pct, srs,
     champion, playoffs, decade, notability)
  with in_progress as (
    -- Only the LATEST season can be unfinished, and it is unfinished exactly
    -- when no champion has been recorded for it. Testing "does every team have
    -- 82 games" would throw away 1999 (50), 2012 (66) and 2020 (unequal).
    select ts.season::int s
      from nba_sumitro_raw.team_summaries ts
     where ts.lg = 'NBA'
       and ts.season::int = (select max(season::int) from nba_sumitro_raw.team_summaries where lg = 'NBA')
       and not exists (select 1 from public.mp_champion_seasons c where c.season = ts.season::int)
     limit 1
  ), base as (
    select ts.season::int                     as season,
           ts.abbreviation                    as abbrev,
           ts.team                            as franchise,
           nullif(ts.w, 'NA')::int            as wins,
           nullif(ts.l, 'NA')::int            as losses,
           nullif(ts.srs, 'NA')::numeric      as srs,
           ts.playoffs = 'TRUE'               as playoffs,
           cs.team is not null                as champion
      from nba_sumitro_raw.team_summaries ts
      left join public.mp_champion_seasons cs
        on cs.season = ts.season::int and cs.team = ts.abbreviation
     where ts.lg = 'NBA'
       and ts.w ~ '^[0-9]+$' and ts.l ~ '^[0-9]+$'
       and ts.season::int is distinct from (select s from in_progress)
  ), scored as (
    select b.*,
           b.wins::numeric / nullif(b.wins + b.losses, 0) as win_pct,
           -- Recency, and deliberately MUCH gentler than the player curve. A
           -- 1950s player is genuinely unknown to this audience; the '86
           -- Celtics and '72 Lakers are canon precisely because they are
           -- history. Reusing mp_rebuild_notability's taper buried them.
           (case when b.season >= 1980 then 1.0
                 when b.season >= 1960 then 0.75 + 0.25 * (b.season - 1960) / 20.0
                 else                       0.50 + 0.25 * (b.season - 1947) / 13.0 end)::numeric as recency
      from base b
  )
  select season, abbrev, franchise,
         (season - 1) || '-' || lpad((season % 100)::text, 2, '0') || ' ' || franchise as label,
         public.mp_normalize((season - 1) || '-' || lpad((season % 100)::text, 2, '0') || ' ' || franchise),
         wins, losses, round(win_pct, 4), srs, champion, playoffs, (season / 10) * 10,
         round(recency * (
             (case when champion then 40 else 0 end)      -- a banner is most of what is remembered
           + (case when playoffs then 6 else 0 end)
           + greatest(0, coalesce(srs, 0)) * 2.5          -- how dominant, schedule-adjusted
           + greatest(0, win_pct - 0.5) * 60              -- and how it looked in the standings
         ), 2)
    from scored;

  get diagnostics n = row_count;
  return n;
end $$;

select public.mp_rebuild_team_seasons();

-- ---------------------------------------------------------------- 4. item_type
alter table public.mp_tier_topics drop constraint if exists mp_tier_topics_item_type_check;
alter table public.mp_tier_topics add constraint mp_tier_topics_item_type_check
  check (item_type in ('player','team','team_season','coach'));
alter table public.mp_tier_themes drop constraint if exists mp_tier_themes_item_type_check;
alter table public.mp_tier_themes add constraint mp_tier_themes_item_type_check
  check (item_type in ('player','team','team_season','coach'));

-- ---------------------------------------------------------------- 5. content
-- "Greatest single seasons" already held team-seasons ('1995-96 Chicago
-- Bulls'); only its label was wrong. Retyping touches presentation alone —
-- item_set is untouched, so every existing board's assignment keys still
-- resolve. This is the one case where an UPDATE on a shipped theme is safe,
-- and it is safe precisely because the set does not move.
update public.mp_tier_themes set item_type = 'team_season' where slug = 'greatest-teams';
update public.mp_tier_topics set item_type = 'team_season' where share_token = 'theme_greatest-teams';

-- The all-time franchise theme is the question this migration exists to
-- replace. Retired, not deleted: retirement drops it from the themes list
-- while mp_tier_topics keeps the play row, so ?tier=theme_franchise-tiers
-- still opens and no existing board disappears. Same rule as an unlisted list
-- topic — moderation and retirement gate DISCOVERY, never a share link.
update public.mp_tier_themes set status = 'retired' where slug = 'franchise-tiers';

-- Two year-specific replacements, hand-authored. A curated theme is a fixed
-- set everyone tiers, so these are written rather than drawn.
select public.mp_seed_tier_theme(
  'title-teams-2010s',
  'Title teams of the 2010s',
  'Ten champions, one decade. Which banner means the most?',
  'Where does the {item} land?',
  'team_season',
  array[
    '2009-10 Los Angeles Lakers',
    '2010-11 Dallas Mavericks',
    '2011-12 Miami Heat',
    '2012-13 Miami Heat',
    '2013-14 San Antonio Spurs',
    '2014-15 Golden State Warriors',
    '2015-16 Cleveland Cavaliers',
    '2016-17 Golden State Warriors',
    '2017-18 Golden State Warriors',
    '2018-19 Toronto Raptors'
  ], 50::smallint);

select public.mp_seed_tier_theme(
  'never-won-it',
  'Great teams that never won it',
  'Sixty-plus wins, no parade. Whose season still hurts?',
  'How high does the {item} go?',
  'team_season',
  array[
    '2015-16 Golden State Warriors',
    '2015-16 San Antonio Spurs',
    '2008-09 Cleveland Cavaliers',
    '2017-18 Houston Rockets',
    '2006-07 Dallas Mavericks',
    '1996-97 Utah Jazz',
    '1993-94 Seattle SuperSonics',
    '1990-91 Portland Trail Blazers',
    '2000-01 Philadelphia 76ers',
    '2012-13 Oklahoma City Thunder'
  ], 55::smallint);
