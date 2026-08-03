# Future fixes

Known-incomplete things. Each entry says what is wrong, why it matters, and what
the fix actually is — so picking one up does not mean re-deriving the
investigation. Ideas for things that don't exist yet live in [IDEAS.md](IDEAS.md).

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

## Shipped since this doc was written

- **Colleges and conferences** (migration 0032) — the investigation that lived
  here is now in the migration header, which is where it belongs. Colleges join
  100% on the same Basketball-Reference id `mp_player_facets` uses, conferences
  are a curated `mp_college_conferences` mapping, and both compose with every
  existing filter.
- **One `player_key` namespace** (migration 0031).

## Ideas that are not fixes
Content and feature ideas — including **height, country of birth and jersey
number**, all three checked and all three blocked on data coverage — live in
[IDEAS.md](IDEAS.md).
