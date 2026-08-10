-- =========================================================================
-- 0042 — "Greatest single seasons" listed the wrong Spurs.
--
-- Found by cross-checking every curated team-season label against the table
-- 0041 built: the theme carried '2014-15 San Antonio Spurs', who went 55-27
-- and won nothing. The team meant is the 2013-14 side — 62-20, and the one
-- that took the title back off Miami. Exactly the ambiguity that makes "the
-- 2014 Spurs" a bad way to name a team, which is the whole reason this batch
-- of work exists.
--
-- ⚠️ This bends the "never change a shipped theme's item_set" rule, and the
-- exemption is narrow enough to state precisely: changing a set orphans the
-- assignment keys on boards already built against it, and this theme's 9
-- boards are ALL demo rows (author_client_id like 'demo\_%'), which exist to
-- be thrown away. The guard below re-checks that at run time rather than
-- trusting today's count — if a real person has since tiered this theme, the
-- update is skipped and a new slug is the only correct fix.
-- =========================================================================
do $$
declare
  wrong_key text := public.mp_normalize('2014-15 San Antonio Spurs');
  right_lbl text := '2013-14 San Antonio Spurs';
  tid uuid;
  real_boards integer;
begin
  select id into tid from public.mp_tier_topics where share_token = 'theme_greatest-teams';
  if tid is null then
    raise notice '0042: theme topic missing, nothing to do';
    return;
  end if;

  select count(*) into real_boards from public.mp_tier_lists
   where topic_id = tid and author_client_id not like 'demo\_%';
  if real_boards > 0 then
    raise warning '0042: % real board(s) on greatest-teams — set left alone, ship a new slug instead', real_boards;
    return;
  end if;

  -- Swap the one item, in place, on both the catalogue row and the play row.
  update public.mp_tier_themes
     set item_set = (
       select jsonb_agg(case when x->>'key' = wrong_key
                             then jsonb_build_object('key', public.mp_normalize(right_lbl), 'label', right_lbl)
                             else x end order by ord)
         from jsonb_array_elements(item_set) with ordinality t(x, ord))
   where slug = 'greatest-teams';

  update public.mp_tier_topics
     set item_set = (
       select jsonb_agg(case when x->>'key' = wrong_key
                             then jsonb_build_object('key', public.mp_normalize(right_lbl), 'label', right_lbl)
                             else x end order by ord)
         from jsonb_array_elements(item_set) with ordinality t(x, ord))
   where id = tid;

  -- The demo boards were built against the old set; one of their assignment
  -- keys no longer exists, so they would report a consensus for an item that
  -- is not on the board. Clear them rather than leave a half-valid board.
  delete from public.mp_tier_lists where topic_id = tid;
end $$;
