-- Daily Court and player-authored Take data is served only by the mp Edge
-- Function under service role. Keep the tables out of the public Data and
-- GraphQL APIs even on projects whose default table grants expose new tables.
revoke all privileges on table public.mp_court_days from anon, authenticated;
revoke all privileges on table public.mp_court_take_locks from anon, authenticated;
revoke all privileges on table public.mp_take_topics from anon, authenticated;
revoke all privileges on table public.mp_take_locks from anon, authenticated;
