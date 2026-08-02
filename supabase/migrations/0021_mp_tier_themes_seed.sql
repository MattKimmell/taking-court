-- =========================================================================
-- 0021  The first five curated themes.
--
-- Chosen for argument density, not coverage: every set should have at least
-- two placements a hoops fan would argue about at a bar. Sets are self-
-- contained — actionTierSave validates assignments against topic.item_set, so
-- a theme needs no join to the player tables and can name anyone.
--
-- `invite` is the share question. It names ONE specific item ('{item}' is
-- substituted at share time) and centres the reader's opinion, so a recipient
-- who has never seen the app still knows what is being asked of them:
-- "Where is Vince Carter on your all-time dunker ranks?" reads as a question
-- you cannot help answering. A generic "rank these 8 players" does not.
--
-- Exactly one theme is featured. That is the hero slot on tier home, and it is
-- how the first boards concentrate into a single pool fast enough to clear the
-- 3-board score gate. The other four stay browsable.
--
-- Re-runnable: mp_seed_tier_theme upserts the catalogue row on slug and leaves
-- any already-created canonical topic untouched.
-- =========================================================================

-- FEATURED. Most accessible of the five — everyone has a dunk opinion, and the
-- Carter/Jordan/Dominique argument is genuinely unresolvable.
select public.mp_seed_tier_theme(
  'all-time-dunkers',
  'All-time dunkers',
  'Rim-rockers across five decades. Settle it.',
  'Where is {item} on your all-time dunker ranks?',
  'player',
  array['Vince Carter','Michael Jordan','Dominique Wilkins','Julius Erving',
        'Shawn Kemp','Blake Griffin','Zach LaVine','Aaron Gordon',
        'Clyde Drexler','Darryl Dawkins'],
  10::smallint, true);

-- The nostalgia bomb. Every name here is an argument about what was taken away.
select public.mp_seed_tier_theme(
  'what-if-careers',
  'The what-if careers',
  'Injuries, timing, luck. How high do they go if it all broke right?',
  'How high does {item} go if the injuries never happened?',
  'player',
  array['Penny Hardaway','Grant Hill','Derrick Rose','Brandon Roy',
        'Greg Oden','Yao Ming','Bill Walton','Tracy McGrady',
        'Ralph Sampson'],
  20::smallint);

select public.mp_seed_tier_theme(
  'aughts-superstars',
  '2000s superstars',
  'The decade of Kobe, Shaq, and the seven-seconds Suns.',
  'Be honest — what tier is {item} in the 2000s?',
  'player',
  array['Kobe Bryant','Tim Duncan','Shaquille O''Neal','Allen Iverson',
        'Kevin Garnett','Dirk Nowitzki','Steve Nash','Jason Kidd',
        'Tracy McGrady','Paul Pierce'],
  30::smallint);

select public.mp_seed_tier_theme(
  'tens-point-guards',
  'Point guards of the 2010s',
  'The position changed more than any other. Rank the ones who changed it.',
  'Where does {item} land among 2010s point guards?',
  'player',
  array['Stephen Curry','Chris Paul','Russell Westbrook','Damian Lillard',
        'Kyrie Irving','John Wall','Rajon Rondo','Kyle Lowry',
        'Mike Conley'],
  40::smallint);

select public.mp_seed_tier_theme(
  'franchise-tiers',
  'Franchise tiers',
  'Not this season — all of it. Banners, eras, heartbreak.',
  'Is {item} really a top-tier franchise?',
  'team',
  array['Los Angeles Lakers','Boston Celtics','Chicago Bulls','San Antonio Spurs',
        'Golden State Warriors','Miami Heat','Detroit Pistons','Philadelphia 76ers',
        'New York Knicks','Sacramento Kings'],
  50::smallint);
