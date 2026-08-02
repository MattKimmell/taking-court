-- =========================================================================
-- 0022  Ten more curated themes (catalogue goes 5 -> 15).
--
-- Sourced from research into what NBA fans actually argue about on X, then
-- cut hard. Four candidates were rejected and the reasons are worth keeping,
-- because the same mistakes will be tempting next time:
--
--   * "most impactful rookies"  -- 8/10 items identical to "all-time greats".
--     The same board with a different title is not a second theme.
--   * "iconic dunkers"          -- 7/10 overlap with the shipped all-time-dunkers.
--   * "greatest what-if careers"-- 6/10 overlap with the shipped what-if-careers.
--   * "most overrated careers"  -- off-vision. The whole scoring design avoids
--     ever telling someone their take is wrong (every spice band is a compliment
--     or a joke), and a theme whose premise is "who is overrated" points that
--     negativity at players instead. The list was also miscategorised: Grant Hill
--     and Tracy McGrady are injury what-ifs, Steve Francis and Darius Miles are
--     busts. If this energy is wanted later, "Better than you remember" is the
--     same argument with the opposite valence.
--
-- Overlap among the ten kept tops out at 5/10 (greats <-> clutch), which is
-- fine: ranking Jordan *as a clutch performer* is a genuinely different
-- judgement from ranking him all-time, and that is how tier-list culture works.
--
-- Name corrections against mp_player_notability (all others verified to resolve
-- via mp_normalize):
--   "Penny Hardaway"       -> "Anfernee Hardaway"
--   "Pistol Pete Maravich" -> "Pete Maravich"
--   "Len Bias"             -> dropped; he never played an NBA game, so he has no
--                             row, and a career that ended that way is not a fit
--                             for a light "talking ball" set.
--
-- all-time-dunkers stays FEATURED. "The all-time greats" is the most generic
-- prompt in basketball; dunkers is the better nostalgia hook and the lower bar
-- to a first opinion.
--
-- Re-runnable: mp_seed_tier_theme upserts on slug and never mutates a canonical
-- topic that already has boards.
-- =========================================================================

-- The canonical argument. Kept generic on purpose: it is the one set every
-- visitor already has an opinion about, so it is the widest on-ramp.
select public.mp_seed_tier_theme(
  'all-time-greats',
  'The all-time greats',
  'The names that still start arguments in every group chat.',
  'Be honest — what tier is {item} on your all-time list?',
  'player',
  array['Michael Jordan','LeBron James','Kareem Abdul-Jabbar','Magic Johnson',
        'Bill Russell','Kobe Bryant','Larry Bird','Wilt Chamberlain',
        'Shaquille O''Neal','Tim Duncan'],
  60::smallint);

-- Strongest concept of the batch: the premise itself is the argument.
select public.mp_seed_tier_theme(
  'ring-or-bust',
  'Ring or bust',
  'Great careers, no jewellery. Does it change where they land?',
  'Does the missing ring actually move {item} down your list?',
  'player',
  array['Charles Barkley','Karl Malone','John Stockton','Elgin Baylor',
        'Dominique Wilkins','Patrick Ewing','Chris Paul','James Harden',
        'Russell Westbrook','Allen Iverson'],
  70::smallint);

select public.mp_seed_tier_theme(
  'clutch-performers',
  'The most clutch',
  'Fourth quarter, two minutes left. Who do you actually want?',
  'Down two with the clock running out — what tier is {item}?',
  'player',
  array['Michael Jordan','Kobe Bryant','LeBron James','Larry Bird',
        'Reggie Miller','Damian Lillard','Kawhi Leonard','Dirk Nowitzki',
        'Ray Allen','Robert Horry'],
  80::smallint);

select public.mp_seed_tier_theme(
  'pure-scorers',
  'Pure scorers',
  'Not the best players. The ones who could simply get a bucket.',
  'Purely as a scorer — where does {item} land?',
  'player',
  array['Michael Jordan','Kevin Durant','Kobe Bryant','Allen Iverson',
        'George Gervin','Dominique Wilkins','Carmelo Anthony','Stephen Curry',
        'James Harden','Adrian Dantley'],
  90::smallint);

select public.mp_seed_tier_theme(
  'floor-generals',
  'The best passers',
  'Vision, timing, and passes that made everyone else better.',
  'As a pure passer, what tier is {item}?',
  'player',
  array['Magic Johnson','John Stockton','Steve Nash','Chris Paul',
        'Jason Kidd','Oscar Robertson','Isiah Thomas','Rajon Rondo',
        'Nikola Jokic','Bob Cousy'],
  100::smallint);

-- The counterweight to a catalogue that otherwise rewards scoring.
select public.mp_seed_tier_theme(
  'lockdown-defenders',
  'Greatest defenders',
  'Rim protectors, pests, and the guys nobody wanted to see switch onto them.',
  'On defence alone — what tier is {item}?',
  'player',
  array['Bill Russell','Hakeem Olajuwon','Dennis Rodman','Scottie Pippen',
        'Gary Payton','Kevin Garnett','Dikembe Mutombo','Ben Wallace',
        'David Robinson','Kawhi Leonard'],
  110::smallint);

select public.mp_seed_tier_theme(
  'greatest-big-men',
  'Greatest big men',
  'Before the league went small, these guys decided everything.',
  'Where does {item} rank among the great big men?',
  'player',
  array['Kareem Abdul-Jabbar','Wilt Chamberlain','Bill Russell','Shaquille O''Neal',
        'Hakeem Olajuwon','Moses Malone','David Robinson','Patrick Ewing',
        'Nikola Jokic','Yao Ming'],
  120::smallint);

select public.mp_seed_tier_theme(
  'international-greats',
  'The international greats',
  'The players who made the NBA a world league.',
  'Among international players, what tier is {item}?',
  'player',
  array['Dirk Nowitzki','Hakeem Olajuwon','Tim Duncan','Giannis Antetokounmpo',
        'Nikola Jokic','Steve Nash','Tony Parker','Manu Ginóbili',
        'Pau Gasol','Luka Dončić'],
  130::smallint);

-- Only coach set in the catalogue, so zero item overlap with anything else.
select public.mp_seed_tier_theme(
  'greatest-coaches',
  'Greatest coaches',
  'Rings, systems, and how much of it was really the roster.',
  'Rings aside — what tier is {item} as a coach?',
  'coach',
  array['Phil Jackson','Gregg Popovich','Pat Riley','Red Auerbach',
        'Chuck Daly','Jerry Sloan','Don Nelson','Larry Brown',
        'Erik Spoelstra','Steve Kerr'],
  140::smallint);

-- Distinct from franchise-tiers: single championship squads, not franchises.
-- Labels are season-scoped and intentionally do not resolve to a team row --
-- item_set is self-contained JSON and tier_save validates against it, so a
-- theme can name anything.
select public.mp_seed_tier_theme(
  'greatest-teams',
  'Greatest single seasons',
  'One roster, one year. Which one beats the others on a neutral floor?',
  'On a neutral floor, what tier is the {item}?',
  'team',
  array['1995-96 Chicago Bulls','2016-17 Golden State Warriors','1985-86 Boston Celtics',
        '1986-87 Los Angeles Lakers','2000-01 Los Angeles Lakers','1971-72 Los Angeles Lakers',
        '2012-13 Miami Heat','2007-08 Boston Celtics','2003-04 Detroit Pistons',
        '2014-15 San Antonio Spurs'],
  150::smallint);
