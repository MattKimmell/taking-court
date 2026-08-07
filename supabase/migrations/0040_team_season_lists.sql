-- 0040 — A team is a season, not a franchise.
--
-- "Best NBA franchises of all time" asks you to rank Bulls against Cavs, which
-- collapses sixty years into one word and produces the least interesting version
-- of the argument: everyone lists the Celtics and the Lakers and there is
-- nothing to defend. The debate people actually have is 96 Bulls against 17
-- Warriors against 01 Lakers — a specific roster, in a specific year.
--
-- So: a new entry_type. It is the axis the browse screen already groups on
-- (ENTRY_CATS in index.html), so a new value gets its own shelf for free.
alter table public.mp_list_topics drop constraint if exists mp_list_topics_entry_type_check;
alter table public.mp_list_topics add constraint mp_list_topics_entry_type_check
  check (entry_type in ('player','team','team_season','coach','moment'));

-- The franchise question is NOT edited in place. Two people have already
-- answered it, and "Lakers" is a fair answer to the question they were asked and
-- a wrong one to this question — rewriting the prompt would silently turn their
-- boards into nonsense. Same rule as a shipped tier theme's item_set: ship a new
-- slug, never repoint an old one.
--
-- It comes off the shelf instead. review_status gates DISCOVERY only (0016), so
-- the share link keeps working and both boards survive.
update public.mp_list_topics
   set review_status = 'unsubmitted', submitted_at = null
 where creator_client_id = 'seed'
   and prompt = 'Best NBA franchises of all time';

insert into public.mp_list_topics
  (share_token, prompt, ranked, max_items, entry_type,
   creator_client_id, creator_label, visibility, review_status, submitted_at, reviewed_at)
select 'list_teamszn01', 'Greatest single-season teams ever', true, 10, 'team_season',
       'seed', 'Taking Court', 'public', 'approved', now(), now()
where not exists (
  select 1 from public.mp_list_topics where share_token = 'list_teamszn01');
