-- 0036 — Round 2 "I'm ready", so the host is not guessing when to reveal.
--
-- Round 2 has no clock: the host decides when to reveal. Without a way for the
-- other four people to say "I'm done", the host is guessing — so they either
-- reveal early over someone still deciding, or the room sits waiting on nobody.
-- A board row already exists the moment anyone taps a number (it autosaves), so
-- "has a row" cannot mean "is ready". submitted_at is the explicit signal.
--
-- Nullable and un-set-able on purpose: a mis-tap on Lock it in must be
-- recoverable, so party_tier_save takes submit:false as well.
--
-- Note there is deliberately NO emoji column on mp_party_members. A member's
-- emoji is derived from their position in join order (see PARTY_EMOJI in
-- party.ts): joined_at never changes, so the derived value is stable for the
-- life of the session, and a stored copy would be a second version of a fact
-- the row already carries — free to drift, and racy to assign on concurrent
-- joins.
alter table public.mp_party_round_boards
  add column if not exists submitted_at timestamptz;

create index if not exists mp_party_round_boards_submitted
  on public.mp_party_round_boards (round_id) where submitted_at is not null;
