#!/usr/bin/env python3
"""Generate demo tier boards that are opinionated but plausible.

Random assignments would be worse than useless: every item would land ~50/50,
"MOST DIVIDED" would fire on noise, and Michael Jordan would show up in F tier,
which makes the compare screen impossible to evaluate. So each theme gets a
defensible baseline ranking, and each synthetic persona perturbs it according to
a stated bias. That produces real consensus at the top, real argument in the
middle, and a divisive item you can point at and agree is genuinely contested.

Emits SQL to stdout. Deterministic: fixed seed, so re-running gives byte-identical
output and the migration stays reviewable.
"""
import hashlib, json, random, sys

TIERS = ["S", "A", "B", "C", "D", "F"]

# ---------------------------------------------------------------------------
# Baseline rank order per theme (best -> worst). These are *defensible*, not
# "correct" -- the point is that a hoops fan would recognise the shape.
BASELINES = {
"all-time-dunkers": ["Michael Jordan","Vince Carter","Julius Erving","Dominique Wilkins",
    "Shawn Kemp","Clyde Drexler","Blake Griffin","Zach LaVine","Aaron Gordon","Darryl Dawkins"],
"what-if-careers": ["Bill Walton","Grant Hill","Penny Hardaway","Derrick Rose","Yao Ming",
    "Tracy McGrady","Brandon Roy","Ralph Sampson","Greg Oden"],
"aughts-superstars": ["Tim Duncan","Kobe Bryant","Shaquille O'Neal","Kevin Garnett",
    "Dirk Nowitzki","Allen Iverson","Steve Nash","Jason Kidd","Tracy McGrady","Paul Pierce"],
"tens-point-guards": ["Stephen Curry","Chris Paul","Russell Westbrook","Damian Lillard",
    "Kyrie Irving","John Wall","Kyle Lowry","Mike Conley","Rajon Rondo"],
"franchise-tiers": ["Los Angeles Lakers","Boston Celtics","Golden State Warriors","Chicago Bulls",
    "San Antonio Spurs","Philadelphia 76ers","Detroit Pistons","Miami Heat",
    "New York Knicks","Sacramento Kings"],
"all-time-greats": ["Michael Jordan","LeBron James","Kareem Abdul-Jabbar","Bill Russell",
    "Magic Johnson","Wilt Chamberlain","Larry Bird","Shaquille O'Neal","Tim Duncan","Kobe Bryant"],
"ring-or-bust": ["Charles Barkley","Karl Malone","John Stockton","Allen Iverson","Elgin Baylor",
    "Patrick Ewing","Chris Paul","James Harden","Dominique Wilkins","Russell Westbrook"],
"clutch-performers": ["Michael Jordan","Kobe Bryant","LeBron James","Larry Bird","Reggie Miller",
    "Damian Lillard","Kawhi Leonard","Dirk Nowitzki","Ray Allen","Robert Horry"],
"pure-scorers": ["Michael Jordan","Kevin Durant","Kobe Bryant","Allen Iverson","George Gervin",
    "Stephen Curry","Carmelo Anthony","Dominique Wilkins","James Harden","Adrian Dantley"],
"floor-generals": ["Magic Johnson","John Stockton","Oscar Robertson","Steve Nash","Chris Paul",
    "Jason Kidd","Isiah Thomas","Bob Cousy","Nikola Jokic","Rajon Rondo"],
"lockdown-defenders": ["Bill Russell","Hakeem Olajuwon","Kevin Garnett","Scottie Pippen",
    "David Robinson","Gary Payton","Dennis Rodman","Kawhi Leonard","Dikembe Mutombo","Ben Wallace"],
"greatest-big-men": ["Kareem Abdul-Jabbar","Wilt Chamberlain","Shaquille O'Neal","Hakeem Olajuwon",
    "Bill Russell","Moses Malone","David Robinson","Nikola Jokic","Patrick Ewing","Yao Ming"],
"international-greats": ["Hakeem Olajuwon","Tim Duncan","Dirk Nowitzki","Nikola Jokic",
    "Giannis Antetokounmpo","Luka Dončić","Steve Nash","Manu Ginóbili","Pau Gasol","Tony Parker"],
"greatest-coaches": ["Phil Jackson","Gregg Popovich","Red Auerbach","Pat Riley","Erik Spoelstra",
    "Chuck Daly","Larry Brown","Steve Kerr","Jerry Sloan","Don Nelson"],
"greatest-teams": ["1995-96 Chicago Bulls","2016-17 Golden State Warriors","1986-87 Los Angeles Lakers",
    "1985-86 Boston Celtics","2000-01 Los Angeles Lakers","1971-72 Los Angeles Lakers",
    "2012-13 Miami Heat","2014-15 San Antonio Spurs","2007-08 Boston Celtics","2003-04 Detroit Pistons"],
}

# ---------------------------------------------------------------------------
# Personas. `shift` moves an item up (negative) or down (positive) in rank when
# a tag matches. `noise` is how erratic they are generally. This is what turns a
# single baseline into a believable spread of opinion.
MODERN   = {"LeBron James","Stephen Curry","Kevin Durant","Nikola Jokic","Giannis Antetokounmpo",
            "Luka Dončić","Kawhi Leonard","Damian Lillard","James Harden","Russell Westbrook",
            "Erik Spoelstra","Steve Kerr","2016-17 Golden State Warriors"}
OLD      = {"Bill Russell","Wilt Chamberlain","Oscar Robertson","Bob Cousy","Elgin Baylor",
            "Kareem Abdul-Jabbar","Julius Erving","George Gervin","Red Auerbach","Adrian Dantley",
            "1971-72 Los Angeles Lakers","1985-86 Boston Celtics","Darryl Dawkins"}
RINGLESS = {"Charles Barkley","Karl Malone","John Stockton","Allen Iverson","Elgin Baylor",
            "Patrick Ewing","Chris Paul","James Harden","Dominique Wilkins","Russell Westbrook",
            "Reggie Miller","Steve Nash","Carmelo Anthony"}

# How much of the S..F range a theme actually uses. This matters more than any
# other knob: a purely positional cut forces the worst item into F, so "the 10th
# best all-time great" comes out F tier, which nobody would ever do. An elite set
# is top-heavy and compresses into S..C; only a set with genuinely weak members
# (franchises, dunk-contest guys) earns the bottom tiers.
BANDS = {
  "all-time-greats":      ("S", "B"),   # every name is a top-15 player
  "greatest-big-men":     ("S", "C"),
  "lockdown-defenders":   ("S", "C"),
  "clutch-performers":    ("S", "C"),
  "pure-scorers":         ("S", "C"),
  "floor-generals":       ("S", "C"),
  "international-greats": ("S", "C"),
  "greatest-coaches":     ("S", "C"),
  "ring-or-bust":         ("S", "C"),   # all-timers; the ring is the argument
  "aughts-superstars":    ("S", "C"),
  "greatest-teams":       ("S", "C"),   # all championship squads
  "all-time-dunkers":     ("S", "D"),
  "tens-point-guards":    ("S", "D"),
  "what-if-careers":      ("A", "D"),   # unrealised careers: nobody is S
  "franchise-tiers":      ("S", "F"),   # the Kings really are down there
}

PERSONAS = [
  # (label,            modern, old,  ringless, noise)
  ("HoopsDad77",         +1.5, -1.5,   +0.5, 0.7),   # old head
  ("CourtVision",        -1.5, +1.5,   -0.5, 0.7),   # modern lean
  ("RingCounter",         0.0,  0.0,   +2.5, 0.5),   # rings are everything
  ("StatHead22",         -0.5, +0.5,   -1.5, 0.6),   # numbers over narrative
  ("BarstoolBenny",      +0.5, -0.5,   +1.0, 1.4),   # loud and erratic
  ("TheProfessor",        0.0,  0.0,    0.0, 0.4),   # near-chalk
  ("SixthManSam",        -1.0, +0.5,   -1.0, 0.9),
  ("NostalgiaNate",      +2.0, -2.0,   +0.5, 0.8),   # strongest old-head
  ("AnalyticsAmy",       -1.0, +1.0,   -2.0, 0.5),
  ("CasualCarl",          0.0,  0.0,   +0.5, 1.6),   # knows the big names only
  ("DeepCutDee",         +0.5, -1.0,   -1.0, 1.1),   # loves the forgotten guys
  ("PrimeTimePat",       -0.5,  0.0,   +1.5, 0.8),
  ("BenchMobBrian",      +0.5, -0.5,    0.0, 1.2),
  ("BoxScoreBecca",      -1.0, +0.5,   -1.0, 0.6),
]

def board_for(persona, order, rng, band=("S", "F")):
    """Perturb the baseline rank, then cut into the theme's tier band.

    Two people ranking the same set rarely use the same number of tiers, so the
    band is jittered per persona: some bunch everyone into S/A, others spread out.
    That is what stops every item landing on the same modal at ~86%.
    """
    label, w_mod, w_old, w_ring, noise = persona
    scored = []
    for i, item in enumerate(order):
        pos = float(i)
        if item in MODERN:   pos += w_mod
        if item in OLD:      pos += w_old
        if item in RINGLESS: pos += w_ring
        pos += rng.gauss(0, noise)
        scored.append((pos, item))
    scored.sort()

    top, bot = TIERS.index(band[0]), TIERS.index(band[1])
    # Personal generosity: some raters give out more S's, some fewer.
    shift = rng.choice([-1, 0, 0, 0, 1])
    top = max(0, min(len(TIERS) - 1, top + shift))
    bot = max(top, min(len(TIERS) - 1, bot + shift))
    span = bot - top + 1

    n = len(scored)
    out = {}
    for rank, (_, item) in enumerate(scored):
        frac = rank / max(n - 1, 1)
        # Bias toward the top of the band -- real boards are top-heavy.
        idx = top + int((frac ** 1.25) * span)
        out[item] = TIERS[min(idx, bot)]
    return out

# ---------------------------------------------------------------------------
# The Daily. Matt plays this every day, so it is the screen most worth having a
# real "room" behind. Baselines here are prestige orderings rather than authored
# sets, because a daily's items are a random draw.
DAILY_BASELINES = {
"daily_2026-07-30": (["Los Angeles Lakers","Chicago Bulls","Miami Heat","Houston Rockets",
    "Oklahoma City Thunder","Washington Wizards","New Orleans Pelicans","Orlando Magic",
    "Los Angeles Clippers","Charlotte Hornets"], ("S","F")),
"daily_2026-07-31": (["Julius Erving","Reggie Miller","Dale Ellis","Mark Jackson","Marques Johnson",
    "Brad Daugherty","Sleepy Floyd","Calvin Natt","Austin Carr","Johnny Davis"], ("S","F")),
"daily_2026-08-01": (["Boston Celtics","Golden State Warriors","Chicago Bulls","San Antonio Spurs",
    "Philadelphia 76ers","Denver Nuggets","Atlanta Hawks","Cleveland Cavaliers",
    "Washington Wizards","Sacramento Kings"], ("S","F")),
"daily_2026-08-02": (["Gregg Popovich","Chuck Daly","Steve Kerr","Rick Adelman","Nick Nurse",
    "Tyronn Lue","Mike Budenholzer","Dwane Casey"], ("S","D")),
}

def norm(s):
    """Mirror of public.mp_normalize: accent-fold, lowercase, alphanumeric only."""
    import unicodedata
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return "".join(c for c in s.lower() if c.isalnum())

def sql_str(s):
    return "'" + s.replace("'", "''") + "'"

def emit(title, rows, topic_sql):
    """Emit boards as (key, label, tier-string) triples.

    The tier string is one character per item IN item_set ORDER, so SQL can
    rebuild the assignments object by zipping it against the topic's item_set
    with ordinality. That keeps the migration ~9KB instead of ~52KB of repeated
    JSON keys, and makes it reviewable by eye.
    """
    print(f"\n-- {title}: {len(rows)} boards")
    print("insert into public.mp_tier_lists (topic_id, author_client_id, author_label, assignments, created_at)")
    print("select t.id, d.cid, d.label,")
    print("       (select jsonb_object_agg(e.value->>'key', substr(d.tiers, e.ord::int, 1))")
    print("          from jsonb_array_elements(t.item_set) with ordinality e(value, ord)),")
    print("       now() - (d.hrs || ' hours')::interval")
    print("from (values")
    print(",\n".join(rows))
    print(f") as d(ref, cid, label, tiers, hrs)")
    print(topic_sql)
    print("on conflict do nothing;")

def main():
    rng = random.Random(20260802)
    # The tier string is positional against the DB's item_set, which is the
    # order the seed migration wrote -- NOT the ranking order in BASELINES.
    # Getting this wrong would silently put one player's tier on another, so the
    # real order is fetched from the DB and every set is asserted to match.
    ITEMSETS = json.load(open(sys.argv[1], encoding="utf-8"))
    for slug, order in list(BASELINES.items()) :
        db = ITEMSETS.get(slug)
        if db is None:
            sys.exit(f"FATAL: no item_set fetched for theme {slug}")
        if set(db) != set(order):
            sys.exit(f"FATAL: {slug} baseline != DB item_set\n"
                     f"  only in baseline: {sorted(set(order) - set(db))}\n"
                     f"  only in DB:       {sorted(set(db) - set(order))}")
    for tok, (order, _b) in DAILY_BASELINES.items():
        db = ITEMSETS.get(tok)
        if db is None or set(db) != set(order):
            sys.exit(f"FATAL: {tok} baseline != DB item_set")
    print("-- generated by scratchpad/gen_demo.py -- do not hand-edit")
    print(f"-- tier strings are positional against item_set order (verified against DB)")
    rows = []
    for slug, order in BASELINES.items():
        # 7-9 boards per theme: clears the 3-board gate with margin, and gives
        # the consensus enough voters that percentages read sensibly.
        k = 7 + (len(slug) % 3)
        chosen = rng.sample(PERSONAS, k)
        for p in chosen:
            asg = board_for(p, order, rng, BANDS.get(slug, ("S", "F")))
            cid = "demo_" + hashlib.md5((slug + p[0]).encode()).hexdigest()[:12]
            # Tier string follows the ITEM_SET order the DB stores, which is the
            # authored order in BASELINES -- verified against the DB below.
            tiers = "".join(asg[item] for item in ITEMSETS[slug])
            rows.append((slug, cid, p[0], tiers))

    vals = []
    for i, (slug, cid, label, tiers) in enumerate(rows):
        # Backdate over ~3 weeks so the archive looks lived-in.
        vals.append(f"  ({sql_str(slug)},{sql_str(cid)},{sql_str(label)},{sql_str(tiers)},{(i * 7) % 500})")
    emit("themes", vals,
         "join public.mp_tier_themes th on th.slug = d.ref\n"
         "join public.mp_tier_topics t on t.theme_id = th.id and t.kind = 'theme'")

    # ---- Daily boards: give the screen Matt opens every day a real room.
    drows = []
    for token, (order, band) in DAILY_BASELINES.items():
        for j, p in enumerate(rng.sample(PERSONAS, 6)):
            asg = board_for(p, order, rng, band)
            cid = "demo_" + hashlib.md5((token + p[0]).encode()).hexdigest()[:12]
            tiers = "".join(asg[item] for item in ITEMSETS[token])
            drows.append(f"  ({sql_str(token)},{sql_str(cid)},{sql_str(p[0])},{sql_str(tiers)},{(len(drows) * 3) % 60})")
    emit("dailies", drows, "join public.mp_tier_topics t on t.share_token = d.ref")

if __name__ == "__main__":
    main()
