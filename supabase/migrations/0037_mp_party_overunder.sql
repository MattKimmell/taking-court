-- 0037 — "Who's Got More": a fourth Pickup round kind.
--
-- Two players, the room votes who has more of something (rings, All-Stars,
-- career points, …), private answers, one reveal showing the split AND the
-- truth. It is the only round with a right answer that still starts an
-- argument, which is why it earns a slot next to three opinion rounds.
--
-- The kind CHECK was written as a closed list on purpose so a new round type is
-- a deliberate migration rather than a typo. This is that deliberate migration.
alter table public.mp_party_rounds drop constraint if exists mp_party_rounds_kind_check;
alter table public.mp_party_rounds add constraint mp_party_rounds_kind_check
  check (kind in ('rapid','consensus','sudden','overunder'));

-- No new tables. The round's questions live in mp_party_rounds.item_set and the
-- votes in mp_party_round_boards.assignments ({question_key: 'a'|'b'}) — the
-- same one-board-per-member-per-round shape round 2 already uses, so the
-- autosave, the submitted_at ready signal and the primary-key dedupe all come
-- for free.
--
-- ⚠️ item_set holds the ANSWER. publicRound must strip the values and the
-- correct side off every question while the round is live; see stripAnswers()
-- in party.ts. The client is never sent something it can be made to reveal.
--
-- idx <= 8 already accommodates a fourth round.
