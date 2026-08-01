-- =========================================================================
-- 0016  Public browse is opt-in and moderated.
--
-- Creating a topic no longer publishes it. The creator decides at create time
-- whether to submit it for public browse, and a moderator must approve it
-- before it appears in list_browse / tier_browse. Share links are unaffected at
-- every status: an unsubmitted, pending or rejected topic is still fully
-- playable by anyone holding its link. Only discovery is gated.
--
--   review_status  unsubmitted  creator kept it link-only (the default)
--                  pending      submitted, awaiting review
--                  approved     discoverable in Browse
--                  rejected     declined; the share link still works
--
-- `visibility` is retained as the creator's stated intent (public|unlisted);
-- `review_status` is what Browse actually filters on.
--
-- Reviewing (from the Supabase SQL editor):
--   select * from public.mp_review_queue where review_status = 'pending';
--   select public.mp_review_topic('list', '<share_token or uuid>', 'approve');
--   select public.mp_review_topic('tier', '<share_token or uuid>', 'reject', 'off-topic');
-- =========================================================================

-- ---------------------------------------------------------------- columns
alter table public.mp_list_topics
  add column if not exists review_status text not null default 'unsubmitted'
    check (review_status in ('unsubmitted','pending','approved','rejected')),
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at  timestamptz,
  add column if not exists review_note  text;

alter table public.mp_tier_topics
  add column if not exists review_status text not null default 'unsubmitted'
    check (review_status in ('unsubmitted','pending','approved','rejected')),
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at  timestamptz,
  add column if not exists review_note  text;

create index if not exists mp_list_topics_browse
  on public.mp_list_topics(review_status, created_at desc);
create index if not exists mp_tier_topics_browse
  on public.mp_tier_topics(review_status, created_at desc);

-- ---------------------------------------------------------------- backfill
-- Seeded and daily content stays browsable; everything a real user created
-- while browse was automatic drops back into the queue for a decision.
update public.mp_list_topics
   set review_status = 'approved', submitted_at = created_at, reviewed_at = now(),
       review_note = 'grandfathered by 0016'
 where creator_client_id in ('seed','daily') and review_status = 'unsubmitted';

update public.mp_tier_topics
   set review_status = 'approved', submitted_at = created_at, reviewed_at = now(),
       review_note = 'grandfathered by 0016'
 where creator_client_id in ('seed','daily') and review_status = 'unsubmitted';

update public.mp_list_topics
   set review_status = 'pending', submitted_at = created_at
 where coalesce(creator_client_id,'') not in ('seed','daily')
   and visibility = 'public' and review_status = 'unsubmitted';

update public.mp_tier_topics
   set review_status = 'pending', submitted_at = created_at
 where coalesce(creator_client_id,'') not in ('seed','daily')
   and visibility = 'public' and review_status = 'unsubmitted';

-- ------------------------------------------------------------ review queue
-- One row per submitted topic across both modes. security_invoker keeps the
-- underlying deny-all RLS in force, so this is invisible to the anon key even
-- though PostgREST exposes the public schema; the grants below are belt-and-braces.
create or replace view public.mp_review_queue as
  select 'list'::text        as kind,
         t.id,
         t.share_token,
         t.prompt,
         t.entry_type        as subject,
         t.creator_label,
         t.creator_client_id,
         t.review_status,
         t.review_note,
         t.submitted_at,
         t.created_at,
         (select count(*) from public.mp_lists l where l.topic_id = t.id) as author_count
    from public.mp_list_topics t
  union all
  select 'tier'::text,
         t.id,
         t.share_token,
         t.prompt,
         t.item_type,
         t.creator_label,
         t.creator_client_id,
         t.review_status,
         t.review_note,
         t.submitted_at,
         t.created_at,
         (select count(*) from public.mp_tier_lists l where l.topic_id = t.id)
    from public.mp_tier_topics t;

alter view public.mp_review_queue set (security_invoker = on);
revoke all on public.mp_review_queue from public, anon, authenticated;

-- --------------------------------------------------------- review decision
-- p_ref accepts either the topic uuid or its share_token.
create or replace function public.mp_review_topic(
  p_kind     text,
  p_ref      text,
  p_decision text,
  p_note     text default null
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     uuid;
  v_status text;
  v_hit    text;
begin
  if p_kind not in ('list','tier') then
    raise exception 'kind must be list or tier, got %', p_kind;
  end if;
  if p_decision not in ('approve','reject') then
    raise exception 'decision must be approve or reject, got %', p_decision;
  end if;
  v_status := case p_decision when 'approve' then 'approved' else 'rejected' end;

  begin
    v_id := p_ref::uuid;
  exception when others then
    v_id := null;                        -- not a uuid → treat p_ref as a share_token
  end;

  if p_kind = 'list' then
    update public.mp_list_topics
       set review_status = v_status, reviewed_at = now(), review_note = p_note
     where (v_id is not null and id = v_id)
        or (v_id is null and share_token = p_ref)
    returning share_token into v_hit;
  else
    update public.mp_tier_topics
       set review_status = v_status, reviewed_at = now(), review_note = p_note
     where (v_id is not null and id = v_id)
        or (v_id is null and share_token = p_ref)
    returning share_token into v_hit;
  end if;

  if v_hit is null then
    raise exception 'no % topic matching %', p_kind, p_ref;
  end if;
  return format('%s %s → %s', p_kind, v_hit, v_status);
end;
$$;

-- `from public` alone is NOT enough: Supabase's default privileges hand every
-- new function in this schema an explicit EXECUTE grant to anon + authenticated,
-- which a PUBLIC revoke leaves untouched. Without naming those roles this
-- SECURITY DEFINER function stays callable over PostgREST with the anon key —
-- i.e. anyone could approve their own topic. Revoke from all three.
revoke all on function public.mp_review_topic(text,text,text,text) from public, anon, authenticated;
grant execute on function public.mp_review_topic(text,text,text,text) to postgres, service_role;
