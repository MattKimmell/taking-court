-- =========================================================================
-- 0024  A curated catalogue over the recall ("Name It") challenges.
--
-- WHY A SEPARATE TABLE, not columns on perfect_sheets:
-- perfect_sheets is NOT ours alone. It is referenced by perfect_sheet_answers,
-- _aliases, _completions, _forfeits and _schedule, and this database also hosts
-- crossword_attempts, daily_climb_sessions and endless_runs -- another app
-- shares it. Adding presentation columns to a shared table would leak Taking
-- Court's UI concerns into someone else's schema. This layer is additive and
-- mp_-prefixed, and dropping it would leave the shared tables untouched.
--
-- IT ALSO FIXES THE TITLES. Sheet prompts literally begin "Name the 8 players
-- with the most career points (NBA regular season)." and the UI then adds the
-- count again. `title` is a display override, so the browse screen can say
-- "Career points" without a data migration on a table we do not own. The full
-- prompt is still what the player sees once the challenge starts.
--
-- Categories are the browse axis. Today they are subject-based and there are
-- only three, because there are only 15 approved challenges -- 6 of which are
-- the same "career leaders" shape. That is the honest state: this schema is
-- built so the browse screen has somewhere to grow when the filtered generator
-- (team / G-F-C / decade) lands, not because 15 items need a taxonomy.
-- =========================================================================

create table if not exists public.mp_challenge_categories (
  slug        text primary key,
  label       text not null,
  blurb       text,
  icon        text not null default '🏀',
  sort_order  smallint not null default 100,
  status      text not null default 'approved' check (status in ('draft','approved','retired')),
  created_at  timestamptz not null default now()
);

create table if not exists public.mp_challenge_catalog (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('sheet','roster')),
  sheet_id        uuid references public.perfect_sheets(id)   on delete cascade,
  roster_sheet_id uuid references public.mp_roster_sheets(id) on delete cascade,
  category_slug   text not null references public.mp_challenge_categories(slug) on delete restrict,
  title           text,          -- display override; null falls back to the prompt
  blurb           text,
  featured        boolean not null default false,
  sort_order      smallint not null default 100,
  status          text not null default 'approved' check (status in ('draft','approved','retired')),
  created_at      timestamptz not null default now(),
  -- exactly one of the two sheet references, matching `kind`
  constraint mp_challenge_catalog_one_ref check (
    (kind = 'sheet'  and sheet_id is not null and roster_sheet_id is null) or
    (kind = 'roster' and roster_sheet_id is not null and sheet_id is null)
  )
);

-- A sheet may appear in the catalogue once. Two partial indexes rather than one
-- over both columns, because a plain unique(sheet_id, roster_sheet_id) would let
-- duplicates through on the null side.
create unique index if not exists mp_challenge_catalog_sheet_uniq
  on public.mp_challenge_catalog (sheet_id)        where sheet_id is not null;
create unique index if not exists mp_challenge_catalog_roster_uniq
  on public.mp_challenge_catalog (roster_sheet_id) where roster_sheet_id is not null;

-- Exactly one featured challenge, enforced in schema rather than by convention.
-- Same device as mp_tier_themes_one_featured: a second one raises 23505 instead
-- of quietly giving the hero slot two occupants.
create unique index if not exists mp_challenge_catalog_one_featured
  on public.mp_challenge_catalog ((true)) where featured;

alter table public.mp_challenge_categories enable row level security;
alter table public.mp_challenge_catalog    enable row level security;
-- No policies, deliberately: only the edge function's service role reads these,
-- the same invariant every other mp_ table rests on.

-- ---------------------------------------------------------------------------
insert into public.mp_challenge_categories (slug, label, blurb, icon, sort_order) values
  ('career-leaders', 'Career leaders', 'All-time statistical tops. You know the names — can you produce them?', '📊', 10),
  ('team-rosters',   'Team rosters',   'Who suited up where. Gets harder the deeper you dig.',                   '🏟️', 20),
  ('around-league',  'Around the league','Arenas, oddities, and the stuff nobody studies.',                      '🗺️', 30)
on conflict (slug) do update
  set label = excluded.label, blurb = excluded.blurb,
      icon = excluded.icon, sort_order = excluded.sort_order;

-- Trivia sheets. Matched on prompt because ids are generated, and the seed has
-- to stay re-runnable without hardcoding them.
insert into public.mp_challenge_catalog (kind, sheet_id, category_slug, title, blurb, sort_order)
select 'sheet', s.id, v.cat, v.title, v.blurb, v.ord::smallint
from public.perfect_sheets s
join (values
  ('Name the 8 players with the most career points (NBA regular season).',        'career-leaders', 'Career points',   'The scoring list. Start with the obvious ones.',        10),
  ('Name the 8 players with the most career assists (NBA regular season).',       'career-leaders', 'Career assists',  'Pure playmakers, plus one or two you will forget.',     20),
  ('Name the 8 players with the most career rebounds (NBA regular season).',      'career-leaders', 'Career rebounds', 'Mostly big men, mostly a long time ago.',               30),
  ('Name the 8 players with the most career games played (NBA regular season).',  'career-leaders', 'Most games played','Longevity, not greatness. Different list than you think.', 40),
  ('Name the 8 players with the most career blocks (NBA regular season).',        'career-leaders', 'Career blocks',   'Rim protection all-time. Harder than it sounds.',       50),
  ('Name the 8 players with the highest career points-per-game average (min. 100 games, NBA regular season).',
                                                                                  'career-leaders', 'Best scoring average', 'Per game, not total. The order will surprise you.', 60),
  ('Name the 8 current NBA arenas with the largest seating capacity.',            'around-league',  'Biggest arenas',  'Nobody studies for this one.',                          10)
) as v(prompt, cat, title, blurb, ord) on v.prompt = s.prompt
where s.status = 'approved'
-- the WHERE repeats the partial index predicate; without it Postgres
-- cannot infer the arbiter and raises 42P10.
on conflict (sheet_id) where sheet_id is not null do update
  set category_slug = excluded.category_slug, title = excluded.title,
      blurb = excluded.blurb, sort_order = excluded.sort_order;

-- Roster sheets. Title is built from the sheet's own structured columns, so new
-- generated sheets can be catalogued the same way without hand-authoring.
insert into public.mp_challenge_catalog (kind, roster_sheet_id, category_slug, title, blurb, sort_order)
select 'roster', r.id, 'team-rosters',
       initcap(r.position) || 's · ' || coalesce(t.name, r.team_abbr)
         || case when r.decade is not null then ' · ' || r.decade || 's' else '' end,
       'Name ' || r.target || '. ' || case r.difficulty
            when 'hard' then 'Deep cut.' else 'A fair ask.' end,
       (row_number() over (order by r.difficulty, r.team_abbr) * 10)::smallint
from public.mp_roster_sheets r
left join (values
  ('LAL','Lakers'),('BOS','Celtics'),('CHI','Bulls'),('SAS','Spurs'),('GSW','Warriors'),
  ('MIA','Heat'),('NYK','Knicks'),('PHI','76ers'),('DET','Pistons'),('SAC','Kings')
) as t(abbr, name) on t.abbr = r.team_abbr
where r.status = 'approved'
on conflict (roster_sheet_id) where roster_sheet_id is not null do update
  set category_slug = excluded.category_slug, title = excluded.title,
      blurb = excluded.blurb, sort_order = excluded.sort_order;

-- FEATURED: career points. The widest on-ramp in the catalogue -- every fan has
-- a guess, and the first four names are free, which is what a hero slot wants.
update public.mp_challenge_catalog set featured = false where featured;
update public.mp_challenge_catalog c set featured = true
  from public.perfect_sheets s
 where s.id = c.sheet_id
   and s.prompt = 'Name the 8 players with the most career points (NBA regular season).';
