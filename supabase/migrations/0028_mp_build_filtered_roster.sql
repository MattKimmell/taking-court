-- =========================================================================
-- 0028  Generate a playable roster sheet from an arbitrary filter set.
--
-- ONE PREDICATE, TWO CALLERS. mp_facet_match is the only place the filter logic
-- lives; both the preview count (0027) and this generator go through it. Separate
-- copies would allow the preview to promise 12 answers while the generated sheet
-- contains 9 — the worst bug available here, because it stays invisible until
-- someone plays and cannot finish.
--
-- Sheets are DEDUPED on source_params. jsonb compares by normalised key order,
-- so the same filter combination reuses its sheet rather than piling up
-- near-identical rows (the team x position grid already occupies ~96).
--
-- The structured columns (position/team_abbr/decade) stay populated wherever the
-- filter maps onto them, so the existing team-grid lookups keep working;
-- source_params is the full truth.
-- =========================================================================

create or replace function public.mp_facet_match(f jsonb, p_min_notability numeric default null)
returns setof public.mp_player_facets language sql stable as $$
  select *
  from public.mp_player_facets
  where (f->>'team'     is null or teams     @> array[f->>'team'])
    and (f->>'position' is null or positions @> array[f->>'position'])
    and (f->>'decade'   is null or decades   @> array[(f->>'decade')::int])
    and (p_min_notability is null or notability >= p_min_notability)
    and (f->>'award' is null or case f->>'award'
           when 'mvp'       then mvp_n     > 0
           when 'dpoy'      then dpoy_n    > 0
           when 'roy'       then roy_n     > 0
           when 'smoy'      then smoy_n    > 0
           when 'mip'       then mip_n     > 0
           when 'allnba'    then allnba_n  > 0
           when 'alldef'    then alldef_n  > 0
           when 'allstar'   then allstar_n > 0
           when 'allstar10' then allstar_n >= 10
           when 'hof'       then hof
           when 'ring'      then rings     > 0
           else true end)
    and (f->>'draft' is null or case f->>'draft'
           when 'first'   then draft_pick  = 1
           when 'top3'    then draft_pick <= 3
           when 'lottery' then draft_pick <= 14
           when 'round1'  then draft_round = 1
           when 'round2'  then draft_round = 2
           else true end);
$$;

-- Re-point the counter at the shared predicate.
create or replace function public.mp_facet_count(f jsonb, p_min_notability numeric default null)
returns int language sql stable as $$
  select count(distinct name_key)::int from public.mp_facet_match(f, p_min_notability);
$$;

create or replace function public.mp_build_filtered_roster(
  f jsonb, p_prompt text, p_target smallint, p_difficulty text default 'normal')
returns uuid language plpgsql as $$
declare sid uuid;
begin
  -- Reuse before creating. Filters are the sheet's identity.
  select id into sid from public.mp_roster_sheets
   where source_params = f and status = 'approved' limit 1;
  if sid is not null then return sid; end if;

  insert into public.mp_roster_sheets
    (prompt, difficulty, position, team_abbr, decade, target, status, source_params)
  values (p_prompt, p_difficulty,
          case f->>'position' when 'G' then 'Guard' when 'F' then 'Forward' when 'C' then 'Center' end,
          f->>'team', (f->>'decade')::int, p_target, 'approved', f)
  returning id into sid;

  -- Pool = every valid answer, no notability floor. The floor decides whether a
  -- combination is FAIR to ask, not what counts as correct.
  insert into public.mp_roster_pool
    (sheet_id, player_key, display_name, last_name, rarity_tier, rarity_score, games)
  select sid, m.player_key, m.player_name, split_part(m.player_name, ' ', -1),
         -- Rarity from notability, not career points: points punish defenders,
         -- and rarity drives both the deep-cut badge and the "you missed"
         -- ordering, which should key on fame.
         case when m.notability >= 55 then 'common'
              when m.notability >= 38 then 'uncommon'
              when m.notability >= 25 then 'rare'
              else 'deep_cut' end,
         coalesce(m.notability, 0)::int, m.games_played
  from public.mp_facet_match(f, null) m;

  -- Last-name-only guessing, but only where the last name is unambiguous inside
  -- this pool. Same rule mp_seed_roster uses.
  update public.mp_roster_pool p set accepted =
    case when (select count(*) from public.mp_roster_pool q
                where q.sheet_id = sid
                  and public.mp_normalize(q.last_name) = public.mp_normalize(p.last_name)) = 1
         then array[public.mp_normalize(p.display_name), public.mp_normalize(p.last_name)]
         else array[public.mp_normalize(p.display_name)] end
  where p.sheet_id = sid;

  return sid;
end $$;

comment on function public.mp_build_filtered_roster(jsonb, text, smallint, text) is
  'Generates (or reuses) a roster sheet for a filter set. Shares its predicate with mp_challenge_preview via mp_facet_match, so the previewed count and the generated pool cannot disagree.';

-- Verified 2026-08-03 with {"team":"CHI","position":"G","award":"allstar"}:
-- preview promised 24, pool had 24 rows, 24 answerable names, and a second
-- build call returned the same sheet id (1 sheet for the combination).
-- Pool top by fame: Jordan, Wade, Pippen, DeRozan, Butler, Rondo.
