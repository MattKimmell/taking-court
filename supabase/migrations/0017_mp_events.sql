-- 0017: minimal product analytics.
--
-- Goal is one question: where do people fall out of the loop between landing on
-- a share link and sharing their own result? Four events cover that funnel;
-- anything more is noise until there's traffic to slice.
--
-- No PII. client_id is the same random local id the app already uses to attach
-- boards to an anonymous player; there is no name, email, or IP stored here.
--
-- Deny-all RLS like every other mp_ table: only the edge function's service
-- role writes, and reads happen from the SQL editor.

create table if not exists public.mp_events (
  id          bigserial primary key,
  event       text        not null,
  client_id   text,
  props       jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists mp_events_event_created_idx
  on public.mp_events (event, created_at desc);
create index if not exists mp_events_client_idx
  on public.mp_events (client_id, created_at desc);

alter table public.mp_events enable row level security;
-- intentionally no policies: service role only

-- Daily funnel. Ordered the way the loop actually runs, so a gap between two
-- adjacent rows on the same day is the drop-off worth chasing.
create or replace view public.mp_funnel as
select
  created_at::date                                          as day,
  count(*) filter (where event = 'landing')                 as landings,
  count(*) filter (where event = 'landing'
                     and props->>'from' = 'share')          as share_landings,
  count(*) filter (where event = 'board_complete')           as boards,
  count(*) filter (where event = 'compare_view')             as compares,
  count(*) filter (where event = 'share_click')              as shares,
  count(distinct client_id)                                  as uniques
from public.mp_events
group by 1
order by 1 desc;
