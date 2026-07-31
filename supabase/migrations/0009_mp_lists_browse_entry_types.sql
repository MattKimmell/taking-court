-- =========================================================================
-- 0009  Lists: public discovery + typed entries. Applied to project
-- ubadgdkajflkmmbmgeov on 2026-07-21.
--   entry_type: what the list is about — player | team | coach | moment
--               (drives the builder's autocomplete: players/teams from the DB,
--                coaches/moments are free text).
--   visibility: public (discoverable in Browse) | unlisted (share-link only).
-- Served by the mp edge function: list_browse returns recent public topics
-- ranked by how many people have listed; suggest supports pool:'teams'.
-- =========================================================================
alter table public.mp_list_topics
  add column if not exists entry_type text not null default 'player'
    check (entry_type in ('player','team','coach','moment'));
alter table public.mp_list_topics
  add column if not exists visibility text not null default 'public'
    check (visibility in ('public','unlisted'));
create index if not exists mp_list_topics_public on public.mp_list_topics(visibility, created_at desc);
