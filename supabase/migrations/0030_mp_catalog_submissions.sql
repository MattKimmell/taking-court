-- =========================================================================
-- 0030  Promote a filter combination into the browse catalogue.
--
-- The payoff of the filter builder: a combination worth playing twice should
-- become permanent content, not something the author has to remember and retype.
-- One insert into the layer 0024 already built.
--
-- PART A IS A BUG FIX AND HAS TO COME FIRST. mp_build_filtered_roster (0028)
-- dedupes sheets on `source_params = f`, using the filter set exactly as the
-- caller sent it. Two things in that set do not belong in a sheet's identity,
-- and production already holds a duplicate caused by each:
--
--   min_notability  Only moves the FAIRNESS GATE. The pool is built with
--                   mp_facet_match(f, null) — no floor — so two sheets differing
--                   only by this flag have byte-identical pools. Live proof:
--                   two "Name 8 forwards who played for the Seattle
--                   SuperSonics." sheets, one with min_notability 0.
--   target          The *requested* ask, which the preview then clamps. So
--                   {team:CHI,decade:1990,position:G} and the same set with
--                   target:8 are different jsonb but the same sheet, and asking
--                   for 12 where only 9 qualify stores 12 next to a resolved 8.
--                   Live proof: two identical "Bulls guards in the 1990s".
--
-- Identity is now mp_facet_key(): the five predicate filters plus the RESOLVED
-- target, and nothing else. `mode` drops out too — top8 is rejected before it
-- reaches here, so every sheet carried a constant. The same canonical value is
-- what builds the pool, so a sheet's stored identity is provably the input that
-- produced its answers.
--
-- This matters to Part B specifically: catalogue titles are derived from
-- source_params, and the unique index on roster_sheet_id cannot catch two
-- DIFFERENT sheets holding identical content. Duplicate browse rows would be the
-- visible symptom of a bug that starts here.
--
-- PART B: submissions are PENDING, not published. Same rule 0016 set for tier
-- and list topics — the built challenge is playable and shareable the moment it
-- exists, and moderation gates discovery only. A catalogue that anyone can write
-- to directly stops being a curated catalogue, which is the only thing it has.
-- =========================================================================

-- ---------------------------------------------------------------------------
-- PART A — a sheet's identity is its predicate plus its resolved ask
-- ---------------------------------------------------------------------------

create or replace function public.mp_facet_key(f jsonb, p_target int)
returns jsonb language sql immutable as $$
  -- Keys that change which players are valid answers, in canonical form. jsonb
  -- normalises key order, so two callers building the same combination in a
  -- different order produce the same key.
  select coalesce(
           (select jsonb_object_agg(k, f->k)
              from unnest(array['team','position','decade','award','draft']) as k
             where f ? k and f->>k is not null),
           '{}'::jsonb)
         || jsonb_build_object('target', p_target);
$$;

comment on function public.mp_facet_key(jsonb, int) is
  'Canonical identity of a filtered roster sheet: the predicate filters plus the resolved target. Excludes min_notability (gate only, never the pool) and mode (constant).';

create or replace function public.mp_build_filtered_roster(
  f jsonb, p_prompt text, p_target smallint, p_difficulty text default 'normal')
returns uuid language plpgsql as $$
declare sid uuid; k jsonb;
begin
  -- One canonical value drives BOTH the dedupe lookup and the pool build, so a
  -- sheet cannot be found by one predicate and filled from another.
  k := public.mp_facet_key(f, p_target::int);

  select id into sid from public.mp_roster_sheets
   where source_params = k and status = 'approved' limit 1;
  if sid is not null then return sid; end if;

  insert into public.mp_roster_sheets
    (prompt, difficulty, position, team_abbr, decade, target, status, source_params)
  values (p_prompt, p_difficulty,
          case k->>'position' when 'G' then 'Guard' when 'F' then 'Forward' when 'C' then 'Center' end,
          k->>'team', (k->>'decade')::int, p_target, 'approved', k)
  returning id into sid;

  -- Pool = every valid answer, no notability floor. The floor decides whether a
  -- combination is FAIR to ask, not what counts as correct.
  insert into public.mp_roster_pool
    (sheet_id, player_key, display_name, last_name, rarity_tier, rarity_score, games)
  select sid, m.player_key, m.player_name, split_part(m.player_name, ' ', -1),
         case when m.notability >= 55 then 'common'
              when m.notability >= 38 then 'uncommon'
              when m.notability >= 25 then 'rare'
              else 'deep_cut' end,
         coalesce(m.notability, 0)::int, m.games_played
  from public.mp_facet_match(k, null) m;

  update public.mp_roster_pool p set accepted =
    case when (select count(*) from public.mp_roster_pool q
                where q.sheet_id = sid
                  and public.mp_normalize(q.last_name) = public.mp_normalize(p.last_name)) = 1
         then array[public.mp_normalize(p.display_name), public.mp_normalize(p.last_name)]
         else array[public.mp_normalize(p.display_name)] end
  where p.sheet_id = sid;

  return sid;
end $$;

-- Backfill the twelve sheets the filter path has produced so far. The 96 grid
-- sheets are left alone: mp_seed_roster owns their params (they carry
-- `pos_source`) and the team-grid lookups read the structured columns anyway.
do $$
declare r record; keep uuid;
begin
  -- Canonicalise first, collisions second: after this the two duplicate pairs
  -- hold identical source_params, which is what makes them findable.
  update public.mp_roster_sheets s
     set source_params = public.mp_facet_key(s.source_params, s.target::int)
   where not (s.source_params ? 'pos_source');

  for r in
    select source_params, count(*) n from public.mp_roster_sheets
     where status = 'approved' and not (source_params ? 'pos_source')
     group by source_params having count(*) > 1
  loop
    -- Keep whichever sheet somebody has actually played; ties go to the oldest.
    -- The loser is RETIRED, never deleted: retired rows fall out of the reuse
    -- lookup and out of browse, but any mp_challenges row still pointing at one
    -- keeps working.
    select s.id into keep from public.mp_roster_sheets s
     where s.source_params = r.source_params and s.status = 'approved'
     order by (select count(*) from public.mp_challenges c where c.roster_sheet_id = s.id) desc,
              s.created_at asc
     limit 1;

    update public.mp_roster_sheets set status = 'retired'
     where source_params = r.source_params and status = 'approved' and id <> keep;

    raise notice 'merged % duplicate sheets for %, kept %', r.n, r.source_params, keep;
  end loop;
end $$;

-- Structural, so the class of bug cannot recur. Partial on `approved` because
-- retired duplicates are exactly what the backfill just created.
create unique index if not exists mp_roster_sheets_params_uniq
  on public.mp_roster_sheets (source_params)
  where status = 'approved' and source_params is not null;

-- ---------------------------------------------------------------------------
-- Team labels, so SQL stops carrying the map inline
-- ---------------------------------------------------------------------------
-- 0025 had this list as a CTE inside a DO block, which made it unreachable from
-- anywhere else. Titles need it at runtime now, so it becomes a table. Same 36
-- franchises: 30 current plus the six throwbacks.
create table if not exists public.mp_team_labels (
  abbr       text primary key,
  label      text not null,
  sort_order smallint not null default 100
);
alter table public.mp_team_labels enable row level security;
-- No policies: service role only, like every other mp_ table.

insert into public.mp_team_labels (abbr, label, sort_order) values
  ('ATL','Hawks',10),('BOS','Celtics',20),('BRK','Brooklyn Nets',30),('CHO','Hornets',40),
  ('CHI','Bulls',50),('CLE','Cavaliers',60),('DAL','Mavericks',70),('DEN','Nuggets',80),
  ('DET','Pistons',90),('GSW','Warriors',100),('HOU','Rockets',110),('IND','Pacers',120),
  ('LAC','Clippers',130),('LAL','Lakers',140),('MEM','Grizzlies',150),('MIA','Heat',160),
  ('MIL','Bucks',170),('MIN','Timberwolves',180),('NOP','Pelicans',190),('NYK','Knicks',200),
  ('OKC','Thunder',210),('ORL','Magic',220),('PHI','76ers',230),('PHO','Suns',240),
  ('POR','Trail Blazers',250),('SAC','Kings',260),('SAS','Spurs',270),('TOR','Raptors',280),
  ('UTA','Jazz',290),('WAS','Wizards',300),
  ('SEA','Seattle SuperSonics',400),('NJN','New Jersey Nets',410),
  ('WSB','Washington Bullets',420),('CHH','Charlotte Hornets (1988-2002)',430),
  ('VAN','Vancouver Grizzlies',440),('BUF','Buffalo Braves',450)
on conflict (abbr) do update set label = excluded.label, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- PART B — submissions
-- ---------------------------------------------------------------------------

alter table public.mp_challenge_catalog
  add column if not exists submitted_by   text,
  add column if not exists submitted_at   timestamptz,
  add column if not exists reviewed_at    timestamptz,
  add column if not exists review_note    text,
  add column if not exists source_filters jsonb;

-- `pending` and `rejected` join the vocabulary, matching 0016's words for the
-- same states. Curated rows stay `approved`; nothing existing changes meaning.
alter table public.mp_challenge_catalog drop constraint if exists mp_challenge_catalog_status_check;
alter table public.mp_challenge_catalog add constraint mp_challenge_catalog_status_check
  check (status in ('draft','pending','approved','rejected','retired'));

-- Two different sheets can hold the same content — the filter path and the
-- team grid both produce "Bulls guards", by different routes. What a browser
-- sees is (category, group, title), so that is what has to be unique. This is
-- the check the roster_sheet_id index structurally cannot make.
create unique index if not exists mp_challenge_catalog_slot_uniq
  on public.mp_challenge_catalog (category_slug, coalesce(group_key, ''), lower(title));

create index if not exists mp_challenge_catalog_pending
  on public.mp_challenge_catalog (status, submitted_at desc) where status = 'pending';

-- Three new shelves. All three render only once non-empty (actionChallengeCatalog
-- drops categories with no items), so seeding them ahead of any submission costs
-- nothing and keeps the routing rules below honest about where things land.
insert into public.mp_challenge_categories (slug, label, blurb, icon, sort_order) values
  ('trophy-case', 'Trophy case', 'MVPs, champions, Hall of Famers. Who actually won what.', '🏆', 15),
  ('draft-night', 'Draft night',  'Where they went, and how that turned out.',              '🎯', 25),
  ('eras',        'Eras',         'Who was around when. Loose on purpose — it is a debate.', '🕰️', 35)
on conflict (slug) do update
  set label = excluded.label, blurb = excluded.blurb,
      icon = excluded.icon, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Display text derived from a filter set
-- ---------------------------------------------------------------------------
create or replace function public.mp_facet_phrase(p_kind text, p_value text)
returns text language sql immutable as $$
  select case p_kind
    when 'award' then case p_value
      when 'mvp' then 'MVP' when 'dpoy' then 'DPOY'
      when 'roy' then 'Rookie of the Year' when 'smoy' then 'Sixth Man'
      when 'mip' then 'Most Improved' when 'allnba' then 'All-NBA'
      when 'alldef' then 'All-Defense' when 'allstar' then 'All-Stars'
      when 'allstar10' then '10+ All-Star teams' when 'hof' then 'Hall of Fame'
      when 'ring' then 'Champions' else p_value end
    when 'draft' then case p_value
      when 'first' then '1st overall' when 'top3' then 'Top-3 picks'
      when 'lottery' then 'Lottery picks' when 'round1' then '1st-round picks'
      when 'round2' then '2nd-round picks' else p_value end
    when 'position' then case p_value
      when 'G' then 'Guards' when 'F' then 'Forwards' when 'C' then 'Centers' else p_value end
    when 'team' then coalesce((select label from public.mp_team_labels where abbr = p_value), p_value)
    when 'decade' then p_value || 's'
    else p_value end;
$$;

-- Which shelf a combination belongs on, and its title there.
--
-- The MOST DISTINCTIVE filter picks the shelf: an award beats a draft position
-- beats a team beats an era. Then the title lists everything the shelf does not
-- already say — inside the Bulls group the title is "Guards", not "Bulls guards"
-- — which is why it can collide with a grid entry and why that collision is
-- caught rather than duplicated.
create or replace function public.mp_catalog_slot(f jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_cat text; v_gk text := null; v_gl text := null; v_go smallint := null;
  parts text[] := '{}';
begin
  if f->>'award' is not null then v_cat := 'trophy-case';
  elsif f->>'draft' is not null then v_cat := 'draft-night';
  elsif f->>'team' is not null then
    v_cat := 'team-rosters';
    -- Slot into the team's existing group so a promoted challenge lands beside
    -- the grid entries for that franchise rather than starting a rival group.
    v_gk := f->>'team';
    v_gl := public.mp_facet_phrase('team', v_gk);
    select group_order into v_go from public.mp_challenge_catalog
     where group_key = v_gk and group_order is not null and group_order < 999 limit 1;
    v_go := coalesce(v_go, 999);      -- 999 = last, the value 0025 already uses
  else v_cat := 'eras';
  end if;

  -- Title order is fixed so two people describing the same set get the same
  -- string, which is what makes the slot index a real dedupe.
  if f->>'award' is not null then parts := parts || public.mp_facet_phrase('award', f->>'award'); end if;
  if f->>'draft' is not null then parts := parts || public.mp_facet_phrase('draft', f->>'draft'); end if;
  if f->>'position' is not null then parts := parts || public.mp_facet_phrase('position', f->>'position'); end if;
  if f->>'team' is not null and v_gk is null then parts := parts || public.mp_facet_phrase('team', f->>'team'); end if;
  if f->>'decade' is not null then parts := parts || public.mp_facet_phrase('decade', f->>'decade'); end if;

  return jsonb_build_object(
    'category', v_cat, 'group_key', v_gk, 'group_label', v_gl, 'group_order', v_go,
    -- Inside a team group with no other filter there is nothing left to say, and
    -- an empty title would break the slot index.
    'title', coalesce(nullif(array_to_string(parts, ' · '), ''), 'Any position'));
end $$;

-- ---------------------------------------------------------------------------
-- Submit
-- ---------------------------------------------------------------------------
-- Refusals are informational: the caller has already built and can already play
-- the challenge, so nothing here is allowed to fail the play path. Every return
-- carries `ok` plus a `reason` the client can print.
create or replace function public.mp_catalog_submit(
  f jsonb, p_roster_sheet_id uuid, p_client_id text default null)
returns jsonb language plpgsql as $$
declare
  v_sheet record; v_key jsonb; v_slot jsonb; v_pv jsonb;
  v_existing record; v_id uuid; v_sort smallint;
begin
  select * into v_sheet from public.mp_roster_sheets where id = p_roster_sheet_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_such_sheet'); end if;

  v_key := public.mp_facet_key(f, v_sheet.target::int);

  -- At least one real filter. "Name 8 players" is not a challenge.
  if (select count(*) from jsonb_object_keys(v_key) k where k <> 'target') = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_filters');
  end if;

  -- Judged at the DEFAULT notability floor, whatever the author ticked. A
  -- combination that only clears the gate because deep cuts were allowed is not
  -- a fair thing to put in front of a stranger; mp_facet_key already dropped the
  -- flag, so this is the standard-floor verdict by construction.
  v_pv := public.mp_challenge_preview(v_key);
  if v_pv->>'verdict' <> 'ok' then
    return jsonb_build_object('ok', false, 'reason', 'too_thin',
                              'verdict', v_pv->>'verdict', 'known', v_pv->'known');
  end if;

  v_slot := public.mp_catalog_slot(v_key);

  -- Already listed, by either route: this exact sheet, or something else already
  -- occupying the same shelf slot (the team grid, or an earlier submission).
  select * into v_existing from public.mp_challenge_catalog
   where roster_sheet_id = p_roster_sheet_id;
  if v_existing.id is null then
    select * into v_existing from public.mp_challenge_catalog
     where category_slug = v_slot->>'category'
       and coalesce(group_key,'') = coalesce(v_slot->>'group_key','')
       and lower(title) = lower(v_slot->>'title');
  end if;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'already', true, 'status', v_existing.status,
                              'catalog_id', v_existing.id, 'title', v_existing.title,
                              'category', v_existing.category_slug);
  end if;

  -- After the curated rows in its shelf, in submission order.
  select coalesce(max(sort_order), 0) + 10 into v_sort
    from public.mp_challenge_catalog
   where category_slug = v_slot->>'category'
     and coalesce(group_key,'') = coalesce(v_slot->>'group_key','');

  insert into public.mp_challenge_catalog
    (kind, roster_sheet_id, category_slug, title, blurb,
     group_key, group_label, group_order, sort_order, status,
     submitted_by, submitted_at, source_filters)
  values ('roster', p_roster_sheet_id, v_slot->>'category',
          v_slot->>'title',
          'Name ' || v_sheet.target || '. ' || (v_pv->>'known') || ' names most fans would know.',
          v_slot->>'group_key', v_slot->>'group_label', (v_slot->>'group_order')::smallint,
          v_sort, 'pending', p_client_id, now(), v_key)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'already', false, 'status', 'pending',
                            'catalog_id', v_id, 'title', v_slot->>'title',
                            'category', v_slot->>'category', 'known', v_pv->'known');
end $$;

comment on function public.mp_catalog_submit(jsonb, uuid, text) is
  'Submits a filter-built challenge to the browse catalogue as pending. Refuses without filters or below verdict ok at the default notability floor; reports rather than duplicates when the slot is taken.';

-- ---------------------------------------------------------------------------
-- Review — same shape as mp_review_topic (0016)
-- ---------------------------------------------------------------------------
create or replace view public.mp_catalog_queue as
  select c.id, c.status, c.category_slug, c.title, c.blurb,
         c.group_label, c.submitted_by, c.submitted_at,
         r.prompt, r.target, r.difficulty, c.source_filters,
         (select count(*) from public.mp_roster_pool p where p.sheet_id = r.id) as pool_size
    from public.mp_challenge_catalog c
    join public.mp_roster_sheets r on r.id = c.roster_sheet_id
   where c.status = 'pending'
   order by c.submitted_at;
alter view public.mp_catalog_queue set (security_invoker = on);
revoke all on public.mp_catalog_queue from public, anon, authenticated;

create or replace function public.mp_catalog_review(
  p_id uuid, p_action text, p_note text default null)
returns boolean language plpgsql as $$
declare v_status text;
begin
  v_status := case lower(p_action)
                when 'approve' then 'approved'
                when 'reject'  then 'rejected'
                when 'retire'  then 'retired'
                else null end;
  if v_status is null then
    raise exception 'action must be approve, reject or retire (got %)', p_action;
  end if;
  update public.mp_challenge_catalog
     set status = v_status, reviewed_at = now(), review_note = coalesce(p_note, review_note)
   where id = p_id;
  return found;
end $$;

revoke all on function public.mp_catalog_review(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mp_catalog_review(uuid, text, text) to postgres, service_role;

-- Review from the SQL editor:
--   select * from public.mp_catalog_queue;
--   select public.mp_catalog_review(id, 'approve') from public.mp_catalog_queue;   -- all pending
--   select public.mp_catalog_review('<id>', 'reject', 'too easy');
-- Titles and blurbs are auto-derived on submit; edit the row before approving if
-- the wording deserves better than the generator managed.
