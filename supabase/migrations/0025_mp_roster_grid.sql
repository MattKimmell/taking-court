-- =========================================================================
-- 0025  Generate the team x position roster grid: 15 challenges -> 103.
--
-- DECISIONS MADE HERE (all reversible; see CLAUDE.local.md for the summary):
--
-- 1. QUALITY FLOOR = 12 players at notability >= 30. The player is asked to
--    name 8, so 12 recognizable answers makes it a fair game rather than a
--    memory test of people nobody recalls. Notability, NOT career points:
--    points punish defenders (Rodman, Mutombo, Ben Wallace) and reward volume
--    scorers on bad teams, and notability is already what tier serving uses, so
--    the app has one definition of "famous". The floor drops 14 of 108
--    combinations and every one of them deserved it — Buffalo Braves had 2-3
--    recognizable names, Vancouver 4-7.
--
-- 2. TEAMS = the 30 current franchises plus six throwbacks (Sonics, New Jersey
--    Nets, Washington Bullets, original Charlotte Hornets, Vancouver Grizzlies,
--    Buffalo Braves). The throwbacks were included optimistically and left to
--    the floor to judge; Buffalo and Vancouver did not survive it. Pre-1980
--    abbreviations (Syracuse, Rochester, Fort Wayne, ~26 of them) are excluded
--    outright: real history, wrong audience for a millennial+ hoops app.
--    KNOWN GAP: Charlotte fails all three positions, so the city is absent. The
--    fix is franchise-level abbreviation merging (CHO+CHH+CHA as one team),
--    which needs mp_seed_roster to accept text[] rather than text.
--
-- 3. GROUPING is a generic axis (group_key/group_label), not a team column, so
--    the decade axis lands without a schema or client change.
--
-- 4. EAGER generation. ~15k pool rows / 6MB, and it buys a static catalogue
--    with no request-time generation and no partially-built sheets.
--
-- Existing approved sheets for a combination are REUSED, never duplicated:
-- mp_challenges.roster_sheet_id references them and two have been played.
-- =========================================================================

alter table public.mp_challenge_catalog
  add column if not exists group_key   text,
  add column if not exists group_label text,
  add column if not exists group_order smallint;

create index if not exists mp_challenge_catalog_group_idx
  on public.mp_challenge_catalog (category_slug, group_order, sort_order);

do $$
declare
  r record; sid uuid; diff text; nm text; poslabel text;
begin
  create temp table _grid on commit drop as
  with pm as (select public.mp_normalize(player) nk, max(pos) pos
              from nba_sumitro_raw.player_career_info group by 1),
  teams(abbr, tname, ord) as (values
    ('ATL','Hawks',10),('BOS','Celtics',20),('BRK','Brooklyn Nets',30),('CHO','Hornets',40),
    ('CHI','Bulls',50),('CLE','Cavaliers',60),('DAL','Mavericks',70),('DEN','Nuggets',80),
    ('DET','Pistons',90),('GSW','Warriors',100),('HOU','Rockets',110),('IND','Pacers',120),
    ('LAC','Clippers',130),('LAL','Lakers',140),('MEM','Grizzlies',150),('MIA','Heat',160),
    ('MIL','Bucks',170),('MIN','Timberwolves',180),('NOP','Pelicans',190),('NYK','Knicks',200),
    ('OKC','Thunder',210),('ORL','Magic',220),('PHI','76ers',230),('PHO','Suns',240),
    ('POR','Trail Blazers',250),('SAC','Kings',260),('SAS','Spurs',270),('TOR','Raptors',280),
    ('UTA','Jazz',290),('WAS','Wizards',300),
    ('SEA','Seattle SuperSonics',400),('NJN','New Jersey Nets',410),
    ('WSB','Washington Bullets',420),('CHH','Charlotte Hornets (1988-2002)',430),
    ('VAN','Vancouver Grizzlies',440),('BUF','Buffalo Braves',450)),
  p as (select v.player_name, n.notability, pm.pos,
               unnest(string_to_array(replace(v.teams_played_for,' ',''), ',')) as team
        from public.vw_trivia_player_career_summary v
        join pm on pm.nk = public.mp_normalize(v.player_name)
        left join public.mp_player_notability n
          on public.mp_normalize(n.player_name) = public.mp_normalize(v.player_name)
        where v.season_type='REGULAR')
  select t.abbr, t.tname, t.ord,
         case x.posch when 'G' then 'Guard' when 'F' then 'Forward' else 'Center' end as position,
         count(*) filter (where p.notability >= 30) as known
  from p join teams t on t.abbr = p.team
  cross join (values ('G'),('F'),('C')) as x(posch)
  where p.pos ilike '%'||x.posch||'%'
  group by 1,2,3,4
  having count(*) filter (where p.notability >= 30) >= 12;

  for r in select * from _grid order by ord, position loop
    poslabel := r.position || 's';
    diff := case when r.known >= 30 then 'normal' else 'hard' end;

    select id into sid from public.mp_roster_sheets
     where team_abbr = r.abbr and position = r.position
       and decade is null and status = 'approved' limit 1;

    if sid is null then
      sid := public.mp_seed_roster(
        'Name 8 ' || lower(poslabel) || ' who played for the ' || r.tname || '.',
        diff, r.position, r.abbr, null, 8::smallint);
    end if;

    insert into public.mp_challenge_catalog
      (kind, roster_sheet_id, category_slug, title, blurb,
       group_key, group_label, group_order, sort_order, status)
    values ('roster', sid, 'team-rosters', poslabel,
            'Name 8. ' || r.known || ' names most fans would know.',
            r.abbr, r.tname, r.ord::smallint,
            case r.position when 'Guard' then 1 when 'Forward' then 2 else 3 end::smallint,
            'approved')
    on conflict (roster_sheet_id) where roster_sheet_id is not null do update
      set title = excluded.title, blurb = excluded.blurb,
          group_key = excluded.group_key, group_label = excluded.group_label,
          group_order = excluded.group_order, sort_order = excluded.sort_order,
          category_slug = excluded.category_slug, status = 'approved';
  end loop;
end $$;

-- The two era-scoped sheets seeded by hand earlier ask a different question
-- (team + position + decade). Park them under their team so the drilldown
-- leaves nothing orphaned.
update public.mp_challenge_catalog c
   set group_key = r.team_abbr,
       group_label = coalesce(c.group_label, r.team_abbr),
       group_order = 999, sort_order = 9
  from public.mp_roster_sheets r
 where r.id = c.roster_sheet_id and r.decade is not null and c.group_key is null;

-- Order the team picker by the name people SEE, not by abbreviation. Ordering
-- by abbr put Lakers 13th (LAL) and Celtics 2nd (BOS), which fails the one job
-- a 33-item picker has. Current franchises alphabetical as one block; the
-- throwbacks keep their own block at the end so they read as a deliberate set.
with ranked as (
  select group_key,
         row_number() over (order by (group_order >= 400)::int, lower(group_label)) as rn
  from (select distinct group_key, group_label, group_order
        from public.mp_challenge_catalog
        where category_slug='team-rosters' and group_key is not null and group_order < 999) d
)
update public.mp_challenge_catalog c
   set group_order = (r.rn * 10)::smallint
  from ranked r
 where c.group_key = r.group_key and c.group_order < 999;
