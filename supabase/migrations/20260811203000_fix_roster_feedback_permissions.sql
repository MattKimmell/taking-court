-- The roster feedback helper reads the private nba_sumitro_raw schema. The mp
-- Edge Function calls it with service_role, which may execute the function but
-- intentionally cannot select from that source schema directly. Run the
-- narrowly-scoped helper as its owner while keeping its empty search path and
-- service-role-only execute grant.
alter function public.mp_roster_guess_context(text, text, jsonb)
  security definer;

revoke all on function public.mp_roster_guess_context(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.mp_roster_guess_context(text, text, jsonb)
  to service_role;

comment on function public.mp_roster_guess_context(text, text, jsonb) is
  'Service-role-only, security-definer facts for one submitted roster guess. Uses a locked empty search path and never returns another valid player or an answer pool.';
