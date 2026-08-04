-- =========================================================================
-- 0034  Content for the Pickup browse screen: 6 prompts become 32.
--
-- The six originals keep their hand-authored pools and only gain browse
-- metadata. Two of them — "20,000+ career points" and "3+ championships" — have
-- no equivalent facet filter (there is no points threshold and no ring-count
-- dimension), so regenerating them through mp_party_pool was not an option, and
-- inventing those dimensions to make six rows uniform was not worth it.
--
-- Everything new is generated, so it shares its predicate with the Name It
-- builder and the playability preview.
-- =========================================================================

update public.mp_party_prompts set category_slug='career-leaders',
  title='20,000-point scorers', blurb='The scoring club. Start with the obvious ones.', sort_order=10
 where slug='points-20k';
update public.mp_party_prompts set category_slug='trophy-case',
  title='10+ All-Star selections', blurb='Perennials only. Harder than the room expects.', sort_order=20
 where slug='allstar-10';
update public.mp_party_prompts set category_slug='trophy-case',
  title='Hall of Famers', blurb='Everyone can name a few. Nobody can name them all.',
  featured=true, sort_order=10
 where slug='hall-of-fame';
update public.mp_party_prompts set category_slug='trophy-case',
  title='3+ championships', blurb='Dynasty guys and the ones who tagged along.', sort_order=30
 where slug='rings-3';
update public.mp_party_prompts set category_slug='draft-night',
  title='#1 overall picks', blurb='One a year. You will get further than you think.',
  featured=true, sort_order=10
 where slug='pick-1';
update public.mp_party_prompts set category_slug='draft-night',
  title='Top-3 picks', blurb='Three a year since 1947. Deep water fast.', sort_order=20
 where slug='top-3-picks';

-- Four featured spanning four flavours — a trophy, a draft, an era and a
-- franchise — so the row shows the breadth of the shelves below it rather than
-- four variations on one idea.
do $$
declare r record;
begin
  for r in
    select * from (values
      -- trophy case
      ('party-mvp','Players who won MVP','{"award":"mvp"}','trophy-case',
       'MVP winners','The short list. Every one of them is a household name.',false,20),
      ('party-dpoy','Players who won Defensive Player of the Year','{"award":"dpoy"}','trophy-case',
       'DPOY winners','Rim protectors and pests. A different kind of memory.',false,40),
      ('party-smoy','Players who won Sixth Man of the Year','{"award":"smoy"}','trophy-case',
       'Sixth Man winners','Bench scorers. Surprisingly hard in a room.',false,50),
      ('party-allnba','Players who made an All-NBA team','{"award":"allnba"}','trophy-case',
       'All-NBA','Wide open. Good warm-up for a big group.',false,60),
      -- draft night
      ('party-round2','Second-round picks','{"draft":"round2"}','draft-night',
       'Second-round steals','The ones nobody wanted. Half the fun is the arguing.',false,30),
      ('party-lottery','Lottery picks','{"draft":"lottery"}','draft-night',
       'Lottery picks','Top 14. Broad enough that everyone lands one.',false,40),
      -- college roots
      ('party-conf-acc','Players who came out of the ACC','{"conference":"ACC"}','college-hoops',
       'ACC','Tobacco Road and friends. The deepest conference here.',false,10),
      ('party-conf-bigeast','Players who came out of the Big East','{"conference":"Big East"}','college-hoops',
       'Big East','The classic Big East — Syracuse and Louisville count.',false,20),
      ('party-conf-sec','Players who came out of the SEC','{"conference":"SEC"}','college-hoops',
       'SEC','Kentucky carries it, but not alone.',false,30),
      ('party-conf-pac12','Players who came out of the Pac-12','{"conference":"Pac-12"}','college-hoops',
       'Pac-12','UCLA and everyone who followed.',false,40),
      ('party-conf-bigten','Players who came out of the Big Ten','{"conference":"Big Ten"}','college-hoops',
       'Big Ten','Indiana, Michigan, Michigan State. Grind it out.',false,50),
      ('party-conf-big12','Players who came out of the Big 12','{"conference":"Big 12"}','college-hoops',
       'Big 12','Kansas and Texas do most of the lifting.',false,60),
      ('party-col-unc','Players who went to UNC','{"college":"UNC"}','college-hoops',
       'North Carolina','More NBA names than any other school.',false,70),
      ('party-col-ucla','Players who went to UCLA','{"college":"UCLA"}','college-hoops',
       'UCLA','Kareem down to Westbrook.',false,80),
      ('party-col-kentucky','Players who went to Kentucky','{"college":"Kentucky"}','college-hoops',
       'Kentucky','A one-and-done factory with a long tail.',false,90),
      ('party-col-duke','Players who went to Duke','{"college":"Duke"}','college-hoops',
       'Duke','You will remember how you feel about them.',false,100),
      -- eras
      ('party-era-1980','Players active in the 1980s','{"decade":1980}','eras',
       'The 1980s','Magic, Bird, and 200 guys you half remember.',false,10),
      ('party-era-1990','Players active in the 1990s','{"decade":1990}','eras',
       'The 1990s','Peak nostalgia. Everyone in the room has one.',true,20),
      ('party-era-2000','Players active in the 2000s','{"decade":2000}','eras',
       'The 2000s','Iso ball and hand-checking. Wide open.',false,30),
      ('party-era-2010','Players active in the 2010s','{"decade":2010}','eras',
       'The 2010s','Recent enough that the room will argue about who counts.',false,40),
      -- franchises
      ('party-team-lal','Players who played for the Lakers','{"team":"LAL"}','team-rosters',
       'Lakers','Deep roster, deep history. A good opener.',true,10),
      ('party-team-bos','Players who played for the Celtics','{"team":"BOS"}','team-rosters',
       'Celtics','Banners all the way back.',false,20),
      ('party-team-chi','Players who played for the Bulls','{"team":"CHI"}','team-rosters',
       'Bulls','Everyone starts with the same six names.',false,30),
      ('party-team-nyk','Players who played for the Knicks','{"team":"NYK"}','team-rosters',
       'Knicks','A lot of players, not a lot of banners.',false,40),
      ('party-team-gsw','Players who played for the Warriors','{"team":"GSW"}','team-rosters',
       'Warriors','Two very different eras in one pool.',false,50),
      ('party-team-sas','Players who played for the Spurs','{"team":"SAS"}','team-rosters',
       'Spurs','Quietly enormous. Half of them are internationals.',false,60)
    ) as v(slug, prompt, filters, cat, title, blurb, feat, ord)
  loop
    perform public.mp_seed_party_prompt(r.slug, r.prompt, r.filters::jsonb,
                                        r.cat, r.title, r.blurb, r.feat, r.ord);
  end loop;
end $$;

-- Name It's hero becomes a row too, now that 0033 dropped the one-featured
-- index. Four shelves represented, so the row advertises the catalogue's range.
update public.mp_challenge_catalog set featured = false where featured;
update public.mp_challenge_catalog c set featured = true
 where c.id in (
   select id from public.mp_challenge_catalog
    where (category_slug='career-leaders' and title='Career points')
       or (category_slug='around-league'  and title='Biggest arenas')
       or (category_slug='trophy-case'    and title='Sixth Man · 2010s')
       or (category_slug='team-rosters'   and group_key='LAL' and title='Guards'));

-- Applied 2026-08-03: 32 approved party prompts across 6 categories, 4 featured.
-- Pool sizes run 43 (10+ All-Star) to 1,016 (the 1990s); targets 20-25.
