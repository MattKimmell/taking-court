-- =========================================================================
-- 0026  mp_player_facets — one materialised row per player, so filtered
--       challenge counts are instant.
--
-- WHY THIS EXISTS: counting players for a filter combination against
-- vw_trivia_player_career_summary measured 736 ms. The view re-aggregates
-- 28,180 rows of player_totals on every call (string_agg(DISTINCT ...) per
-- player) and applies the team filter AFTER aggregation, and mp_normalize()
-- runs per row on both sides of two joins so nothing is indexable. At 736 ms a
-- live count is impossible and even a submit-time check with one probe per
-- filter would spend seconds in a spinner.
--
-- Same query against this table: 1.98 ms. Same answer (11 Memphis centres at
-- notability >= 30). That is what makes both the submit-time check and a live
-- count affordable.
--
-- Every expensive thing is precomputed: name_key (so mp_normalize never runs at
-- query time), teams/positions/decades as arrays with GIN indexes, award counts
-- as plain integers.
--
-- Joined on player_key = player_id throughout — verified 100% for the career
-- summary view, mp_player_notability and player_career_info. That is both faster
-- and more correct than matching normalised names.
--
-- ORDERING: reads mp_player_notability, so run AFTER mp_rebuild_notability().
--
-- KNOWN, PRE-EXISTING: 4,884 players collapse to 4,847 distinct name_keys — 37
-- genuine homonyms (three different Charles Joneses, two Eddie Johnsons). A pool
-- containing two same-named players has fewer ANSWERABLE slots than rows, so any
-- count meant to gate playability should use count(distinct name_key), not
-- count(*). This table makes that possible; nothing consumes it yet.
-- =========================================================================

create table if not exists public.mp_player_facets (
  player_key    text primary key,
  player_name   text not null,
  name_key      text not null,          -- mp_normalize(player_name), precomputed
  last_name_key text,                   -- for last-name-only guessing
  first_season  int,
  last_season   int,
  seasons_n     int,
  games_played  int,
  career_points numeric,
  positions     text[]  not null default '{}',   -- {G,F,C} — NEVER PG/SG/SF/PF, the data has no such thing
  teams         text[]  not null default '{}',
  decades       int[]   not null default '{}',   -- every decade the player was active in (loose, for debate)
  allstar_n     int not null default 0,
  allnba_n      int not null default 0,
  alldef_n      int not null default 0,
  mvp_n         int not null default 0,
  dpoy_n        int not null default 0,
  roy_n         int not null default 0,
  smoy_n        int not null default 0,
  mip_n         int not null default 0,
  rings         int not null default 0,
  hof           boolean not null default false,
  draft_pick    int,
  draft_round   int,
  draft_year    int,
  notability    numeric,
  rebuilt_at    timestamptz not null default now()
);

alter table public.mp_player_facets enable row level security;
-- No policies: service role only, same invariant as every other mp_ table.

create index if not exists mp_facets_teams_gin     on public.mp_player_facets using gin (teams);
create index if not exists mp_facets_positions_gin on public.mp_player_facets using gin (positions);
create index if not exists mp_facets_decades_gin   on public.mp_player_facets using gin (decades);
create index if not exists mp_facets_notability    on public.mp_player_facets (notability desc);
create index if not exists mp_facets_name_key      on public.mp_player_facets (name_key);
create index if not exists mp_facets_awards        on public.mp_player_facets (allstar_n, allnba_n, mvp_n);
create index if not exists mp_facets_draft         on public.mp_player_facets (draft_pick);

create or replace function public.mp_rebuild_facets()
returns bigint language plpgsql as $$
declare n bigint;
begin
  -- Full rebuild rather than incremental: 4,884 rows is nothing, and a partial
  -- refresh could leave a player's arrays disagreeing with their scalars.
  truncate public.mp_player_facets;

  insert into public.mp_player_facets (
    player_key, player_name, name_key, last_name_key,
    first_season, last_season, seasons_n, games_played, career_points,
    positions, teams, decades,
    allstar_n, allnba_n, alldef_n, mvp_n, dpoy_n, roy_n, smoy_n, mip_n,
    rings, hof, draft_pick, draft_round, draft_year, notability)
  select
    v.player_key,
    v.player_name,
    public.mp_normalize(v.player_name),
    public.mp_normalize(split_part(v.player_name, ' ', -1)),
    n.first_season, n.last_season, n.seasons_n::int, n.games_played, n.career_points,
    -- positions: parse the combo strings (F-C, G-F, ...) into the only three
    -- position values this data actually has.
    (select coalesce(array_agg(p order by p), '{}')
       from (select unnest(array['G','F','C']) p) z
      where pci.pos ilike '%'||z.p||'%'),
    -- teams: the view stores a comma-joined string; an array is what makes a
    -- containment filter indexable.
    coalesce(string_to_array(replace(v.teams_played_for, ' ', ''), ','), '{}'),
    -- decades: "active during", deliberately loose — the same rule the era lens
    -- on tier pools already uses.
    (select coalesce(array_agg(distinct (s/10)*10 order by (s/10)*10), '{}')
       from generate_series(coalesce(n.first_season, 0), coalesce(n.last_season, 0)) s
      where n.first_season is not null),
    -- All-Star and All-NBA come from notability, already vetted, so the two
    -- tables cannot disagree about them.
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
  -- Individual award WINS. `winner` is stored as text, hence the explicit set.
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
  -- All-Defense is the one honour notability does not track.
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

comment on table public.mp_player_facets is
  'Materialised per-player facets for filtered challenge generation. Rebuild with select public.mp_rebuild_facets(); run it after mp_rebuild_notability().';

-- Applied 2026-08-03: 4,884 rows, 2.6 MB, zero players missing positions,
-- teams or decades. Spot-verified against reality: Jordan 5 MVP / 6 rings /
-- 3rd pick 1984; Ben Wallace 4 DPOY and correctly NULL draft (undrafted);
-- Rodman 8 All-Defense; Jokić 3 MVP; Ginóbili 57th in 1999.
select public.mp_rebuild_facets() as players_indexed;
