-- =========================================================================
-- 0027  mp_challenge_preview — is this filter combination playable, and if not,
--       what should the player relax?
--
-- ONE round trip. The relax-probes (re-count with each active filter dropped)
-- run inside this function, so a full preview is a single db call rather than
-- N+1. At ~2 ms against mp_player_facets (0026) that is affordable; against the
-- old career-summary view each probe was 736 ms and this design was impossible.
--
-- COUNTS DISTINCT name_key, NOT rows. 4,884 players share only 4,847 normalised
-- names — three different Charles Joneses. A pool holding two same-named players
-- has fewer answerable slots than rows, so counting rows would promise a
-- challenge the player cannot finish.
--
-- pool  = every valid answer (what the guesser may type)
-- known = valid AND recognisable (notability >= 30) — what makes it FAIR
-- The gate differs by mode, deliberately:
--   roster (set membership)      gates on `known` — naming 8 of 85 nobodies is a
--                                lookup, not a game
--   top8   (ordered leaderboard) gates on `pool`  — the top N of a filtered pool
--                                are notable by construction
--
-- Rather than refusing a thin combination, the ASK IS CLAMPED DOWN: a pool of 6
-- becomes "Name 5", which is a real game where a hard block is a dead end. Only
-- under 3 is it truly unbuildable, and then the response names the filter that
-- would help most — so the player is told what to change instead of just no.
--
-- No dynamic SQL: award and draft are whitelisted CASE arms.
-- =========================================================================

create or replace function public.mp_facet_count(f jsonb, p_min_notability numeric default null)
returns int language sql stable as $$
  select count(distinct name_key)::int
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

create or replace function public.mp_challenge_preview(f jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_mode   text := coalesce(f->>'mode', 'roster');
  v_want   int  := least(greatest(coalesce((f->>'target')::int, 8), 3), 15);
  v_floor  numeric := coalesce((f->>'min_notability')::numeric, 30);
  v_pool   int;
  v_known  int;
  v_gate   int;
  v_target int;
  v_verdict text;
  v_diff   text := null;
  v_relax  jsonb := null;
  k text; probe jsonb; probe_n int; best_n int := -1; best_k text := null;
begin
  v_pool  := public.mp_facet_count(f, null);
  v_known := public.mp_facet_count(f, v_floor);
  v_gate  := case when v_mode = 'top8' then v_pool else v_known end;
  v_target := least(v_want, greatest(v_gate - 1, 1));

  if v_gate < 3 then
    v_verdict := 'impossible';
    foreach k in array array['team','position','decade','award','draft'] loop
      if f ? k and f->>k is not null then
        probe := f - k;
        probe_n := case when v_mode='top8' then public.mp_facet_count(probe, null)
                        else public.mp_facet_count(probe, v_floor) end;
        if probe_n > best_n then best_n := probe_n; best_k := k; end if;
      end if;
    end loop;
    if best_k is not null then
      v_relax := jsonb_build_object('filter', best_k, 'would_give', best_n);
    end if;
    v_target := null;
  elsif v_gate <= v_target + 2 then
    v_verdict := 'tight';
  else
    v_verdict := 'ok';
  end if;

  -- Difficulty = headroom between what qualifies and what you must name. The
  -- verdict scale only covers the too-SMALL end, so without this "guards in the
  -- 2010s" (139 recognisable names, name 8) reads as a clean 'ok' when it is
  -- trivial. Difficulty informs without nagging, which matters because nothing
  -- in this app tells a player their choice was wrong.
  if v_target is not null then
    v_diff := case
      when v_gate <= v_target + 2   then 'brutal'
      when v_gate <= v_target * 2   then 'hard'
      when v_gate <= v_target * 5   then 'normal'
      else 'easy' end;
  end if;

  return jsonb_build_object(
    'mode', v_mode, 'pool', v_pool, 'known', v_known, 'gate', v_gate,
    'requested_target', v_want, 'target', v_target,
    'clamped', v_target is not null and v_target < v_want,
    'verdict', v_verdict, 'difficulty', v_diff, 'relax', v_relax,
    'min_notability', v_floor
  );
end $$;

comment on function public.mp_challenge_preview(jsonb) is
  'Playability check for a filtered challenge. Returns pool/known counts, a clamped target, verdict ok|tight|impossible, a difficulty estimate, and which filter to relax. Counts distinct name_key because homonyms are not separately answerable.';

-- Verified 2026-08-03:
--   {team:MEM, position:C, award:mvp} -> impossible, relax "team" would give 18
--   {team:SAS, award:mvp}             -> tight/brutal, 3 known, clamped to Name 2
--   {team:MEM, position:C}            -> ok/hard,   11 known
--   {team:SEA, position:G}            -> ok/normal, 28 known
--   {position:G, decade:2010}         -> ok/easy,  139 known
