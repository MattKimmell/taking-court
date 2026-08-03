# Ideas

Content and feature ideas with the feasibility already checked, so picking one up
does not mean re-running the investigation. Fixes for things that are *wrong* live
in [FUTURE_FIXES.md](FUTURE_FIXES.md); this file is for things that don't exist yet.

Each idea says what the data actually supports, because in this app **that is
usually the deciding factor** — a naming game is only fair if the answer pool is
complete, so an axis with gaps is worse than no axis at all.

---

## Blocked on a data pull: height, country, jersey number

All three sound like excellent prompts. All three are **unusable today**, for the
same reason, and it is worth understanding the reason before reaching for any new
axis.

**Where they are:** `nba_raw.common_player_info` has `height`, `weight`, `country`
and `jersey`. That table is in the **nba_api id namespace**, so reaching it from
`mp_player_facets` means going through `nba_recon.player_identity_map` — and only
4,155 of 4,884 players map at all.

**Coverage among the 562 recognisable players** (notability ≥ 30 — the ones the
app actually serves), measured 2026-08-03:

| axis | covered | of 562 | |
|---|---|---|---|
| country of birth | 392 | **70%** | 62 distinct countries |
| height / weight | 385 | **69%** | |
| jersey number | 336 | **60%** | |

### ⚠️ Why partial coverage is worse than no feature

**A missing value is indistinguishable from a negative.** Build "Name 8 players 7
feet or taller" on 69% coverage and roughly a third of genuinely correct answers
are simply absent from the pool — so a player types a right answer and takes a
**strike** for it. That is the worst outcome this app can produce, and it would
look like a bug in the guess matcher rather than a data gap, which makes it
expensive to diagnose and corrosive to trust.

Compare colleges, which shipped: 100% join, and `NA` is an explicit *no college*
marker rather than a blank — so an empty result is a true statement about the
player. That is the bar a new axis has to clear.

### What would unblock them
A data pull that fills the gaps, most sensibly folded into the refresh already
planned for the June 2026 draft and July 2026 free agency (see FUTURE_FIXES). After
that, re-measure coverage at notability ≥ 30 **before** building anything.

Ranked by how good they'd be if the data arrives:

1. **Country of birth** — the most on-vision of the three and improving every
   season. "Name 8 NBA players from France", "…from Serbia", "…from Australia".
   Also the only one that would work as a *tier* prompt, not just a naming one.
2. **Height** — "Name 8 players 7 feet or taller" is a genuinely good bar
   argument, and it needs bucketing rather than exact values, so it may tolerate
   slightly imperfect data better than the others. Wants care: listed heights are
   notoriously unreliable and change between sources.
3. **Jersey number** — lowest coverage and the fiddliest, because players change
   numbers between teams, so "wore 23" is a many-to-many and not an attribute.
   Fun ("name 8 players who wore 23") but it is a different data shape, not just a
   missing column.

---

## Other axes worth a look

- **Group the college shelf by conference.** The browse `group_key` axis is
  generic and already drives the 33-team drilldown, so this needs no schema
  change — pick ACC, then see Duke / UNC / NC State. Not worth it until the shelf
  has more than a handful of items.
- **Era-aware conferences.** `mp_college_conferences` already carries
  `valid_from` / `valid_to`, read by nothing. If anyone ever objects that
  Louisville is listed as Big East, the upgrade is data plus a join on the
  player's seasons — see the reasoning in FUTURE_FIXES and in migration 0032's
  header before changing it, because the current choice is deliberate.
- **Coaches.** `mp_challenge_catalog.kind` and the list `item_type` both already
  contemplate coaches, and nothing serves them. Would need a data source; not
  currently in the warehouse.
- **Played for both franchises.** `public.vw_trivia_players_who_played_for_both`
  is already built, holds **15,274 rows**, and nothing uses it. Columns are
  `team_a, team_b, player_key, player_name, seasons_with_team_a,
  seasons_with_team_b` — so it is *franchise* pairs, not teammate pairs. "Name 8
  players who suited up for both the Lakers and the Celtics" is a strong prompt
  and needs no new data.
  ⚠️ Check the `player_key` namespace before wiring it up — after 0031 the app is
  uniformly Basketball-Reference ids, and warehouse views have drifted before.
  It is a *view*, so a filtered challenge would need the pair predicate added to
  `mp_facet_match` (probably as a two-team array) rather than a join at
  challenge-build time — the whole point of that function is that the count and
  the generated sheet cannot disagree.
- **Teammate pairs** ("played with both LeBron and Wade") are a genuinely
  different and harder shape — they need player-season overlap on the same team,
  which no view currently provides.
