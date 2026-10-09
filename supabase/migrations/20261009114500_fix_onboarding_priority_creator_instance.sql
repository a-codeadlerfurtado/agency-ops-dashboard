-- 2026-10-09: remove obsolete Gustavo-phone guard from priority group creation.
-- The Z-API creator instance is currently Joel (5513996212746). The same
-- instance_id is already pinned in the function and checked for enabled,
-- CONNECTED, and outbound_enabled; a second stale phone equality prevented
-- prepare_priority_onboarding_job from building any priority jobs.
-- Replace only this one guard in the current production definition, preserving
-- all other function logic and privileges. Idempotent and fails closed if the
-- expected source differs.
DO $migration$
DECLARE
  definition text;
  obsolete_guard constant text := 'and i.connected_phone=''5513988051839''';
  current_guard constant text := 'and nullif(i.connected_phone,'''') is not null';
BEGIN
  SELECT pg_get_functiondef('agency_ops.prepare_priority_onboarding_job(bigint)'::regprocedure)
    INTO definition;

  IF position(obsolete_guard in definition) = 0 THEN
    IF position(current_guard in definition) > 0 THEN
      RAISE NOTICE 'Priority creator instance already corrected';
      RETURN;
    END IF;
    RAISE EXCEPTION 'Unexpected priority onboarding function body: review before replacing';
  END IF;

  EXECUTE replace(definition, obsolete_guard, current_guard);
END
$migration$;

DO $verify$
BEGIN
  IF position(
    'and i.connected_phone=''5513988051839'''
    in pg_get_functiondef('agency_ops.prepare_priority_onboarding_job(bigint)'::regprocedure)
  ) > 0 THEN
    RAISE EXCEPTION 'Old group creator phone guard is still present';
  END IF;
END
$verify$;
