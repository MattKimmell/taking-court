-- =========================================================================
-- 0029  Two corrections to the filter builder, both found by running it.
--
-- 1. mp_roster_sheets.position and .team_abbr were NOT NULL, from when every
--    roster sheet was exactly one team and one position. "Lakers players who won
--    MVP" and "second-round DPOYs" are perfectly good challenges with one of
--    those absent, and they failed at INSERT with a constraint violation.
--    Safe to relax: every reader filters by equality, so null rows simply do not
--    match the team-grid lookups and are reachable only via their own filter set.
--    source_params stays the full, non-null truth for every sheet.
--
-- 2. The clamp could produce target = 2, which mp_roster_sheets' own CHECK
--    (3..12) rejects — so a thin combination died with a constraint error rather
--    than being reported as unplayable. The schema was right: below four
--    qualifying names there is no game left. Minimum ask is 3; the impossible
--    threshold moves from <3 to <=3.
--
-- 3. The relax hint now suggests the SMALLEST relaxation that clears the floor,
--    not the largest. Maximal was giving actively bad advice: "second-round
--    DPOYs" was told to drop the award (84 results) when dropping the draft
--    filter leaves 23 and DPOY was obviously the interesting half. "Memphis
--    centres who won MVP" was told to drop the team when dropping MVP leaves 11
--    Memphis centres. Minimal relaxation preserves intent.
-- =========================================================================

alter table public.mp_roster_sheets alter column position  drop not null;
alter table public.mp_roster_sheets alter column team_abbr drop not null;

create or replace function public.mp_challenge_preview(f jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_mode   text := coalesce(f->>'mode', 'roster');
  v_want   int  := least(greatest(coalesce((f->>'target')::int, 8), 3), 12);
  v_floor  numeric := coalesce((f->>'min_notability')::numeric, 30);
  v_min_ask constant int := 3;      -- matches mp_roster_sheets_target_check
  v_pool int; v_known int; v_gate int; v_target int;
  v_verdict text; v_diff text := null; v_relax jsonb := null;
  k text; probe jsonb; probe_n int;
  best_k text := null; best_n int := null;   -- smallest viable relaxation
  fall_k text := null; fall_n int := -1;     -- largest, if none are viable
begin
  v_pool  := public.mp_facet_count(f, null);
  v_known := public.mp_facet_count(f, v_floor);
  v_gate  := case when v_mode = 'top8' then v_pool else v_known end;
  v_target := least(v_want, greatest(v_gate - 1, v_min_ask));

  if v_gate <= v_min_ask then
    v_verdict := 'impossible';
    foreach k in array array['team','position','decade','award','draft'] loop
      if f ? k and f->>k is not null then
        probe := f - k;
        probe_n := case when v_mode='top8' then public.mp_facet_count(probe, null)
                        else public.mp_facet_count(probe, v_floor) end;
        if probe_n > v_min_ask and (best_n is null or probe_n < best_n) then
          best_n := probe_n; best_k := k;
        end if;
        if probe_n > fall_n then fall_n := probe_n; fall_k := k; end if;
      end if;
    end loop;
    if best_k is null then best_k := fall_k; best_n := fall_n; end if;
    if best_k is not null then
      v_relax := jsonb_build_object('filter', best_k, 'would_give', best_n);
    end if;
    v_target := null;
  elsif v_gate <= v_target + 2 then
    v_verdict := 'tight';
  else
    v_verdict := 'ok';
  end if;

  if v_target is not null then
    v_diff := case
      when v_gate <= v_target + 2 then 'brutal'
      when v_gate <= v_target * 2 then 'hard'
      when v_gate <= v_target * 5 then 'normal'
      else 'easy' end;
  end if;

  return jsonb_build_object(
    'mode', v_mode, 'pool', v_pool, 'known', v_known, 'gate', v_gate,
    'requested_target', v_want, 'target', v_target,
    'clamped', v_target is not null and v_target < v_want,
    'verdict', v_verdict, 'difficulty', v_diff, 'relax', v_relax,
    'min_notability', v_floor, 'min_ask', v_min_ask
  );
end $$;

-- Verified 2026-08-03, zero hard errors across nine combinations:
--   Bulls guards 1990s        -> ok/normal,  18 known, Name 8
--   Lakers + MVP              -> tight,      10 known, Name 8  (no position: previously a crash)
--   Knicks centres + HOF      -> tight,       7 known, Name 6  (clamped)
--   2nd-round DPOYs           -> blocked, suggests dropping DRAFT -> 23
--   Memphis centres + MVP     -> blocked, suggests dropping AWARD -> 11
