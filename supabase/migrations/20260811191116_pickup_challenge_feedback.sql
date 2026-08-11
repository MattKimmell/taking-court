-- Preserve the Challenge facet on a live Pickup session so Round 1 can return
-- the same factual player feedback as solo/Daily roster Challenges. The frozen
-- answer pool remains unchanged and no answer data is exposed.
alter table public.mp_party_sessions
  add column if not exists source_filters jsonb not null default '{}'::jsonb;

-- Early first-party prompts predate source_filters. Describe them with the
-- existing facet vocabulary (plus factual numeric thresholds) so every public
-- Pickup preset has meaningful correct/incorrect copy.
update public.mp_party_prompts
set source_filters = case slug
  when 'pick-1' then '{"draft":"first"}'::jsonb
  when 'points-20k' then '{"min_points":20000}'::jsonb
  when 'hall-of-fame' then '{"award":"hof"}'::jsonb
  when 'top-3-picks' then '{"draft":"top3"}'::jsonb
  when 'allstar-10' then '{"award":"allstar10"}'::jsonb
  when 'rings-3' then '{"min_rings":3}'::jsonb
  else source_filters
end
where source_filters is null;

-- Existing sessions created from presets can be repaired from their prompt.
-- Custom sessions created before this migration cannot be reconstructed safely
-- and retain the honest empty object/fallback display.
update public.mp_party_sessions s
set source_filters = p.source_filters
from public.mp_party_prompts p
where s.prompt_id = p.id
  and s.source_filters = '{}'::jsonb
  and p.source_filters is not null;
