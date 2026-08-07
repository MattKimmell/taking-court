-- 0039 — Re-cut every already-built award sheet against the corrected predicate.
--
-- 0038 made mp_facet_match require that an award was won IN the filtered team /
-- decade. Nine sheets were generated under the old, looser rule and their pools
-- are frozen in mp_roster_pool, so they still hold the wrong answers. Worse,
-- three of them are now unplayable: the honest pool is smaller than the ask.
--
--   Bulls guards · All-Star        24 -> 12   (target 8 still fine)
--   Sixth Man · 2010s              15 ->  6   (Name 8 -> Name 5)
--   Lakers · MVP                   10 ->  4   (Name 8 -> Name 3)
--   Spurs · Rookie of the Year      8 ->  3   (2 recognisable — retired)
--
-- The Spurs one is instructive rather than a failure: the real answer is exactly
-- three (Robinson, Duncan, Wembanyama) and only two clear the notability floor,
-- so "name 5" was only ever answerable because the pool was wrong.

-- The pool build, lifted out of mp_build_filtered_roster so a predicate change
-- can be replayed onto existing sheets instead of copy-pasted.
create or replace function public.mp_refill_roster_pool(p_sheet uuid)
returns integer language plpgsql as $$
declare k jsonb; n integer;
begin
  select source_params into k from public.mp_roster_sheets where id = p_sheet;
  if k is null then return 0; end if;

  delete from public.mp_roster_pool where sheet_id = p_sheet;
  insert into public.mp_roster_pool
    (sheet_id, player_key, display_name, last_name, rarity_tier, rarity_score, games)
  select p_sheet, m.player_key, m.player_name, split_part(m.player_name, ' ', -1),
         case when m.notability >= 55 then 'common'
              when m.notability >= 38 then 'uncommon'
              when m.notability >= 25 then 'rare'
              else 'deep_cut' end,
         coalesce(m.notability, 0)::int, m.games_played
  from public.mp_facet_match(k, null) m;

  -- Last-name-only answers are accepted when that surname is unique in THIS
  -- pool. A smaller pool can make a surname newly unique, so this has to be
  -- recomputed, not preserved.
  update public.mp_roster_pool p set accepted =
    case when (select count(*) from public.mp_roster_pool q
                where q.sheet_id = p_sheet
                  and public.mp_normalize(q.last_name) = public.mp_normalize(p.last_name)) = 1
         then array[public.mp_normalize(p.display_name), public.mp_normalize(p.last_name)]
         else array[public.mp_normalize(p.display_name)] end
  where p.sheet_id = p_sheet;

  select count(*) into n from public.mp_roster_pool where sheet_id = p_sheet;
  return n;
end $$;

do $$
declare r record; pv jsonb; newt int;
begin
  for r in select id, source_params, target, prompt
             from public.mp_roster_sheets where source_params ? 'award'
  loop
    perform public.mp_refill_roster_pool(r.id);

    -- Ask the same gate a new build would face, rather than inventing one here.
    pv := public.mp_challenge_preview(
            r.source_params || jsonb_build_object('mode','roster','target', r.target));

    if (pv->>'verdict') = 'impossible' then
      update public.mp_roster_sheets   set status = 'retired' where id = r.id;
      update public.mp_challenge_catalog set status = 'retired' where roster_sheet_id = r.id;
      -- The pool stays. A share link to a retired sheet still resolves, and the
      -- answers it now holds are the correct ones.
      continue;
    end if;

    newt := (pv->>'target')::int;
    if newt <> r.target then
      update public.mp_roster_sheets
         set target = newt,
             prompt = regexp_replace(prompt, '^Name [0-9]+ ', 'Name ' || newt || ' ')
       where id = r.id;
    end if;
  end loop;
end $$;

-- The four prompts whose WORDING was made misleading by the fix. "played for the
-- Lakers and won MVP" describes two independent facts, which is precisely the
-- reading 0038 removed; the pool now means "won MVP while a Laker" and the
-- sentence has to say so. filterPhrase() in games.ts composes it this way for
-- every future build — these four predate it.
update public.mp_roster_sheets set prompt = 'Name 8 guards who made an All-Star team with the Bulls.'
 where source_params @> '{"team":"CHI","award":"allstar","position":"G"}';
update public.mp_roster_sheets set prompt = 'Name 3 players who won MVP with the Lakers.'
 where source_params @> '{"team":"LAL","award":"mvp"}';
update public.mp_roster_sheets set prompt = 'Name 5 players who won Rookie of the Year with the Spurs.'
 where source_params @> '{"team":"SAS","award":"roy"}';
update public.mp_roster_sheets set prompt = 'Name 5 players who won Sixth Man of the Year in the 2010s.'
 where source_params @> '{"award":"smoy","decade":2010}';
