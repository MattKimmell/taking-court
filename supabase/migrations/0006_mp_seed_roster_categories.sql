-- =========================================================================
-- 0006  Seed roster categories via mp_seed_roster(). Applied to project
-- ubadgdkajflkmmbmgeov on 2026-07-21. (Casts required so overload resolves.)
-- Remove all roster content with:  truncate mp_roster_sheets cascade;
-- =========================================================================
select public.mp_seed_roster('Name 8 centers who played for the Los Angeles Lakers.','normal','Center','LAL',null::integer,8::smallint);
select public.mp_seed_roster('Name 8 guards who played for the Chicago Bulls.','normal','Guard','CHI',null::integer,8::smallint);
select public.mp_seed_roster('Name 8 forwards who played for the Boston Celtics.','normal','Forward','BOS',null::integer,8::smallint);
select public.mp_seed_roster('Name 8 centers who played for the New York Knicks.','normal','Center','NYK',null::integer,8::smallint);
select public.mp_seed_roster('Name 8 guards who played for the Golden State Warriors.','normal','Guard','GSW',null::integer,8::smallint);
select public.mp_seed_roster('Name 8 forwards who played for the San Antonio Spurs.','normal','Forward','SAS',null::integer,8::smallint);
select public.mp_seed_roster('Name 6 guards who played for the Lakers and were active in the 2000s.','hard','Guard','LAL',2000::integer,6::smallint);
select public.mp_seed_roster('Name 6 forwards who played for the Heat and were active in the 2010s.','hard','Forward','MIA',2010::integer,6::smallint);

-- Add more in one line each, e.g.:
-- select public.mp_seed_roster('Name 8 guards who played for the Detroit Pistons.','normal','Guard','DET',null::integer,8::smallint);
