# Future fixes and ideas

Known-incomplete things, and content ideas with the feasibility already checked.
Each entry says what is wrong, why it matters, and what the fix actually is — so
picking one up does not mean re-deriving the investigation.

Nothing here is urgent. **The binding constraint is still distribution**: nobody
outside Matt has played end to end. Weigh anything below against whether it helps
acquire or retain a user base that does not exist yet.

---

## Deferred fixes

### 1. The team grid and the filter builder produce different pools
Two paths generate roster answer pools and they do not agree:

| | grid (`mp_seed_roster`) | filter (`mp_build_filtered_roster`) |
|---|---|---|
| positions from | `player_career_info.pos`, `max(pos)` per normalised name | `mp_player_facets.positions` |
| rarity from | career points | notability |
| "Bulls guards" pool | 204 names | 216 names (203 shared) |

**Why it matters:** rarity is *visible*. Rodman scores low on career points and
high on notability, so the same player earns a 🔥 deep-cut badge on one sheet and
not the other. Rarity also orders the "you missed:" recap, which should key on
fame — that is a stated principle the grid sheets predate and violate.

**The fix** is to re-seed the 96 grid sheets through the facets generator, which
also collapses the duplicate sheets (the same combination currently exists twice,
reachable by two routes). **This changes 96 shipped challenges**, so it is a
content decision, not a cleanup — that is the only reason it hasn't been done.

⚠️ **Do not "fix" this by aliasing the two paths** — canonicalising the grid's
`source_params` so a filter request reuses a grid sheet looks like it removes the
duplication, but the pools come from different predicates, so
`mp_challenge_preview` would promise a count the sheet does not hold. That is
exactly the failure 0028's "one predicate, two callers" rule exists to prevent.

### 2. Charlotte is missing from the roster grid
`CHO` fails the 12-known floor at all three positions, because the franchise's
history is split across `CHO` / `CHH` / `CHA`. Fixing it needs franchise-level
abbreviation merging — `mp_seed_roster` taking `text[]` instead of one abbr.
**Do not fix it by lowering the floor.**

### 3. Filtered top-N is not built
`challenge_build` rejects `mode:"top8"`. A top8 challenge sources answers from
`perfect_sheet_answers` via `buildSnapshot`, and `perfect_sheets` belongs to the
other app sharing this database. Doing it properly means building the snapshot at
challenge-creation time and skipping sheets entirely. **Never fix it by writing
into the shared table.**

### 4. Leaderboard has no time scope
`scope: today | week | all` was specced and never built; it always shows all time.
The silent 1000-row truncation is already fixed (`pagedRows`).

### 5. Expired crew tokens 401 instead of refreshing
A crew call with a stale access token returns `UNAUTHORIZED_ASYMMETRIC_JWT` and
the user sees an error. Needs "on 401 → `SB.auth.refreshSession()` → retry once"
in the client's `api()` wrapper.

### 6. The migrations directory cannot rebuild the database
`0010`, `0012` and `0014` were applied ad hoc during the prototype and never
written to files. The live DB is the source of truth. Known debt since the
prototype; worth closing before anyone else ever needs to stand up an environment.

### 7. Three copies of the team-name map
`mp_team_labels` (SQL, added 0030), `TEAM_NAMES` in `games.ts`, and
`FILTER_TEAMS` in `index.html` are the same 36 franchises written three times.
The SQL copy is now authoritative; the other two should read from an endpoint or
be generated.

### 8. `challenge_catalog` returns the whole catalogue in one payload
~35 KB uncompressed at 104 challenges, all categories nested. Fine now. A decade
axis or a college axis multiplies it — that is the point to switch to per-group
fetching. The client already branches on *whether items have a group*, so the
change is server-side.

### 9. Housekeeping
- **Demo data is live** and deliberately so. One call removes it:
  `select public.mp_demo_teardown();` (keeps the 15 curated themes, which are
  content, not demo data).
- **No editorial `featured` flag on list topics** — the Lists hero is whatever is
  most-played. Tier themes and the Name It catalogue both have a proper
  schema-enforced single `featured`; lists should match.
- **The anon key** is a legacy long-lived JWT hardcoded in the client (safe: RLS
  is deny-all). Migrate to the publishable/secret key model at real launch — it
  is one client string.

---

## Content idea: colleges and conferences

**Verified 2026-08-03. The data is there and it is unusually clean.**

**Source:** `nba_sumitro_raw.player_career_info.colleges`, keyed by `player_id` —
the *same* Basketball-Reference id `mp_player_facets.player_key` uses, so it joins
100% with no name matching. (After migration 0031 there is only one player id
namespace in the app, which is what makes this a straightforward join.)

What makes it good:

- **Names are already colloquial**, not registrar formalities: `UNC`, `UCLA`,
  `Duke`, `UConn`, `NC State`, `LSU`. That is what a fan would type, so the
  existing `accepted[]` alias machinery needs nothing special.
- **`NA` is the explicit no-college marker** — 387 players, and it is *correct*:
  LeBron, Kobe, Giannis, Garnett, Dirk, Jokić. Preps-to-pros and internationals
  are absent by fact, not by gap.
- **Transfers are comma-separated**, 542 players with more than one school. Count
  a player at every school they attended — the same deliberately-loose rule the
  decade lens uses, and the right one for a debate game.

### Per-college alone is too thin
At the same floor the team grid uses (≥ 12 distinct players at notability ≥ 30),
only **6 of 554 colleges qualify**:

| college | recognisable | total | headliners |
|---|---|---|---|
| UNC | 22 | 94 | Jordan, Vince Carter, Worthy |
| UCLA | 20 | 104 | Kareem, Westbrook, Reggie Miller |
| Kentucky | 17 | 138 | Anthony Davis, Rondo, Shawn Kemp |
| Duke | 14 | 103 | Grant Hill, Kyrie, Tatum |
| Kansas | 13 | 81 | Pierce, Embiid, Wilt |
| Arizona | 12 | 70 | Iguodala, Steve Kerr, Jason Terry |

Dropping the floor to 8 gives 12 colleges; to 5 gives 33. Six challenges is not a
shelf — but these six are *blue-blood* programs, so they are strong as individual
challenges even if they cannot carry a category.

### Conferences are the real axis
Rolling colleges into conferences clears the floor comfortably everywhere
(estimated with a throwaway mapping, not persisted):

| conference | recognisable | total |
|---|---|---|
| ACC | 74 | 484 |
| SEC | 61 | 462 |
| Pac-12 | 59 | 456 |
| Big Ten | 52 | 516 |
| Big East | 45 | 400 |
| Big 12 | 36 | 294 |

And it **composes with every existing filter**, which is where it gets good:
"ACC guards", "SEC players who won MVP", "Duke players drafted in the top 3",
"Big East players of the 1990s".

### ⚠️ The one real design decision: conferences move
Conference membership is historical and unstable. Maryland was ACC, now Big Ten.
Syracuse and Louisville were Big East, now ACC. Nebraska left the Big 12. The
Pac-12 effectively dissolved in 2024.

So "SEC players" is ambiguous — the conference the school is in **now**, or the
one it was in **when the player played**? Three options:

1. **Current membership.** Simplest, one column, ages badly and reads wrong to the
   target audience — a millennial hoops fan thinks of Syracuse as Big East.
2. **Classic/most-associated membership.** Hand-authored, one column, matches how
   fans actually talk. Reads wrong for recent players (Tatum is Duke/ACC either
   way, but a 2025 Maryland player is Big Ten to anyone under 30).
3. **Era-aware** — `(college, conference, valid_from, valid_to)`. Correct, and
   genuinely more work: the challenge would have to resolve conference against the
   player's seasons.

**Recommendation: option 2**, with the conference label stated in the prompt so
nobody is surprised ("Name 8 Big East players" with Syracuse and Louisville in the
pool is a *feature* for this audience). Option 3 is the honest answer if it ever
becomes contentious; the mapping table should carry the validity columns from day
one even if nothing reads them yet, so upgrading is data, not schema.

### What building it touches
Exactly the shape of adding any other facet — no new architecture:

1. **`mp_player_facets`** — add `colleges text[]`, populate in
   `mp_rebuild_facets()` from `player_career_info.colleges` (split on comma, drop
   `NA`), add a GIN index. Remember the rebuild order:
   `mp_rebuild_notability()` then `mp_rebuild_facets()`.
2. **New `mp_college_conferences`** table — `(college, conference, valid_from,
   valid_to)`. ~70 rows covers the power conferences; the long tail can stay
   unmapped and simply not offer a conference.
3. **`mp_facet_match`** (0028) — add the `college` and `conference` arms. It is
   the single shared predicate, so the preview and the generator both get it free.
4. **`mp_facet_phrase`** / **`mp_catalog_slot`** (0030) — display labels, and
   decide which shelf a college challenge lands on (probably a new `college` one).
5. **`buildChallengeFilters`** + **`composeFilterPrompt`** in `games.ts` —
   whitelist the two new keys, write the English.
6. **`index.html`** — two more selects on the filter form.

The playability gate, the clamp, the relax hint, the catalogue submission path and
the "Suggest for Browse" flow all work unchanged, because they operate on whatever
`mp_facet_match` supports.

### Other axes: checked, and NOT ready — coverage is the problem
`nba_raw.common_player_info` has `height`, `weight`, `country` and `jersey`, and
they sound like great prompts. They are not usable as-is. That table is in the
nba_api id namespace, so it needs `nba_recon.player_identity_map` to join, and
only 4,155 of 4,884 players map at all. Coverage **among the 562 recognisable
players** (notability ≥ 30) — the ones that actually get served:

| axis | covered | of 562 |
|---|---|---|
| country | 392 | 70% |
| height / weight | 385 | 69% |
| jersey number | 336 | 60% |

⚠️ **Partial coverage is worse than no feature here.** A missing value is
indistinguishable from a negative: build "Name 8 players 7 feet or taller" on 69%
coverage and roughly a third of genuinely correct answers are absent from the
pool, so a player types a right answer and takes a **strike** for it. That is the
worst failure this app can produce, and it would look like a bug in the guess
matcher rather than a data gap.

So these need a data pull that fills the gaps first — probably alongside the
already-planned refresh for the June 2026 draft and July 2026 free agency. Until
then, **colleges are the only new axis with the 100% coverage that makes a naming
game fair.** Country in particular is worth revisiting after a pull; "Name 8 NBA
players from France" gets better every season.
