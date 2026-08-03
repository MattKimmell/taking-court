-- =========================================================================
-- 0031  One player_key namespace.
--
-- THE DRIFT: vw_trivia_player_career_summary used to expose nba_api person ids
-- and now exposes Basketball-Reference ids (0015-era change — the recon/nba_raw
-- inner join was removed because it dropped ~732 real players). mp_seed_roster
-- selects v.player_key straight from that view, so it has always been correct
-- *at the time it ran*. What is stale is the data seeded before the change.
--
-- Measured 2026-08-03, and narrower than it first looked:
--   mp_roster_pool     1,211 rows across exactly 8 sheets, all seeded 2026-07-22
--                      (the original hand-authored batch). The 0025 grid wave and
--                      every filter-built sheet are already canonical.
--   mp_roster_picks    10 of 33 rows
--   mp_attempts        6 attempts, 35 filled slots — one still in_progress
--   mp_party_answers   0. Party pools were authored bbref from the start.
--
-- WHY IT MATTERS even though nothing is visibly broken: guess matching is by
-- accepted[] within a single sheet, so today the split is invisible. It stops
-- being invisible the moment anything aggregates a player ACROSS challenges — a
-- most-guessed board, "you have named Jordan 6 times", per-player stats. Jordan
-- would be `893` on the Celtics-forwards sheet and `jordami01` everywhere else,
-- and the two would never add up. This is cheap to fix now and expensive later.
--
-- The mapping is nba_recon.player_identity_map, which exists for exactly this:
-- 4,155 confirmed nba_raw -> sumitro pairs. Every one of the 1,052 distinct stale
-- keys resolves through it. Verified before running: zero collisions, in either
-- direction — no two stale keys resolve to the same id inside one sheet, and no
-- resolved id already exists in the sheet it is landing in.
--
-- ⚠️ WHAT THIS DELIBERATELY DOES NOT DO: it does not merge the grid sheets and
-- the filter-built sheets. They still hold near-identical content under separate
-- ids ("Bulls guards" exists twice), and aliasing them by canonicalising the
-- grid's source_params was considered and rejected — the two pools come from
-- DIFFERENT predicates (mp_seed_roster reads career-summary + player_career_info
-- positions, 204 names; mp_facet_match reads the facet table, 216). Pointing a
-- filter request at a grid sheet would let mp_challenge_preview promise a count
-- the sheet does not contain, which is precisely the failure 0028's
-- "one predicate, two callers" rule exists to prevent. The honest fix is to
-- re-seed the grid through the facets generator; that changes 96 shipped
-- challenges and is its own decision.
-- =========================================================================

create or replace function public.mp_canonical_player_key(p_key text)
returns text language sql stable as $$
  -- Idempotent: canonical keys pass straight through, so this is safe to re-run
  -- and safe to wrap around a key of unknown provenance.
  select coalesce(
    (select i.sumitro_player_id
       from nba_recon.player_identity_map i
      where i.nba_raw_player_id = p_key and i.is_active
      limit 1),
    p_key);
$$;

comment on function public.mp_canonical_player_key(text) is
  'Resolves a legacy nba_api person id to the canonical Basketball-Reference id used by mp_player_facets. Passes canonical keys through unchanged.';

do $$
declare n_pool int; n_picks int; n_att int; n_left int;
begin
  -- Answer pools.
  update public.mp_roster_pool p
     set player_key = public.mp_canonical_player_key(p.player_key)
   where p.player_key ~ '^[0-9]+$';
  get diagnostics n_pool = row_count;

  -- Pick counts (how often each answer has been named on a sheet).
  update public.mp_roster_picks k
     set player_key = public.mp_canonical_player_key(k.player_key)
   where k.player_key ~ '^[0-9]+$';
  get diagnostics n_picks = row_count;

  -- Stored attempts. The in_progress one is the reason this is not optional:
  -- actionGuess builds its already-named set from filled_slots and compares
  -- against pool keys, so leaving the blob stale would let that player name the
  -- same person twice.
  update public.mp_attempts a
     set filled_slots = (
       select jsonb_object_agg(e.key,
                case when e.value->>'player_key' ~ '^[0-9]+$'
                     then jsonb_set(e.value, '{player_key}',
                            to_jsonb(public.mp_canonical_player_key(e.value->>'player_key')))
                     else e.value end)
       from jsonb_each(a.filled_slots) e)
   where exists (select 1 from jsonb_each(a.filled_slots) e
                  where e.value->>'player_key' ~ '^[0-9]+$');
  get diagnostics n_att = row_count;

  raise notice 'remapped: % pool rows, % pick rows, % attempts', n_pool, n_picks, n_att;

  select count(*) into n_left from public.mp_roster_pool where player_key ~ '^[0-9]+$';
  if n_left > 0 then
    raise exception 'still % unmapped pool rows — aborting rather than half-migrating', n_left;
  end if;
end $$;

-- Structural, so the namespaces cannot drift apart again silently. Every one of
-- the 4,884 keys in mp_player_facets matches this shape; the old nba_api ids were
-- bare integers, so a single anchored rule separates them cleanly. If a future
-- data source uses a different id format this fails loudly at insert, which is
-- the entire point — the last drift was silent for two weeks.
alter table public.mp_roster_pool  drop constraint if exists mp_roster_pool_player_key_canonical;
alter table public.mp_roster_pool  add  constraint mp_roster_pool_player_key_canonical
  check (player_key ~ '^[a-z]');
alter table public.mp_roster_picks drop constraint if exists mp_roster_picks_player_key_canonical;
alter table public.mp_roster_picks add  constraint mp_roster_picks_player_key_canonical
  check (player_key ~ '^[a-z]');
