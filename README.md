# Taking Court

**Welcome to the Sport Court of Public Opinion.**

Taking Court is a mobile-first web app for NBA "talking ball" debates. Draw a set of
players, teams, or coaches, sort them into tiers (S → F), and see how your take stacks up
against the room. No account needed — every game is playable from a shared link.

It's a single-page **PWA** (installable, works offline for the shell) served as a static
site on GitHub Pages. All game logic — scoring, timing, validation, the daily draw, and
consensus — runs server-side in a Supabase edge function, so the client is just the view.

## Modes

- **Daily** — one shared debate a day (deterministic, Wordle-style), with a streak and a
  shareable result card. Fridays are **Flashback Friday**: a rotating nostalgia decade
  (’80s / ’90s / ’00s).
- **Tier lists** — spin a filtered pool into a random set, sort S–F, compare consensus, and
  see where your take is hotter than the room. Player pools can be scoped by **era/decade**.
- **Top-8** — timed "name all eight" sheets; three strikes and you're out. Play a friend
  (share link) or the computer.
- **Rosters** — "name N players of position X who played for team Y" with rarity badges.
- **Lists** — subjective, no-wrong-answer lists you make, share, and compare.

Tier lists and Lists are private to their share link by default. Their creator can submit one for public
**Browse**, where it appears only after review — approval gates discovery, never the share link.

## Project layout

```
index.html            The whole app (markup + styles + logic, single file)
manifest.webmanifest  PWA manifest
service-worker.js     App-shell cache (offline shell; API always live)
icons/                App icons + Open Graph share image
.nojekyll             Tell GitHub Pages to serve files as-is (no Jekyll)
```

The backend (Supabase project `ubadgdkajflkmmbmgeov`, edge function `mp`, plus its Postgres
schema and migrations) lives outside this repo. The client talks to it with the public anon
key, which is safe to expose: every table is RLS deny-all and the function is the only way in.

## Run locally

It's a static site — any static server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Service workers need `http(s)`, so open via a server rather than `file://`.)

## Deploy (GitHub Pages)

Push to `main` and enable **Settings → Pages → Deploy from a branch → `main` / root**.
The site publishes at `https://<user>.github.io/taking-court/`. Because all asset paths are
relative, it works at that sub-path with no config. Bump `CACHE` in `service-worker.js` when
you ship a new build so returning visitors pick it up.
