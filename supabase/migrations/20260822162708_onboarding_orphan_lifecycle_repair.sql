create or replace function agency_ops.repair_onboarding_lifecycle_mismatches()
returns integer
language plpgsql
security definer
set search_path='agency_ops','pg_catalog'
as $function$
declare
  v_count integer := 0;
begin
  update agency_ops.clients c
  set lifecycle='ONBOARDING',
      metadata=coalesce(c.metadata,'{}'::jsonb)||jsonb_build_object(
        'lifecycle_corrected_by','ONBOARDING_ORPHAN_SWEEP',
        'lifecycle_corrected_from',c.lifecycle,
        'lifecycle_corrected_at',now(),
        'lifecycle_correction_reason','Existe onboarding OPEN e CAMPAIGN_LAUNCH ainda não está DONE.'
      ),
      updated_at=now()
  where c.lifecycle in ('ACTIVE','PROSPECT')
    and exists(
      select 1
      from agency_ops.onboarding_cases oc
      join agency_ops.onboarding_stages s
        on s.case_id=oc.id and s.stage_code='CAMPAIGN_LAUNCH'
      where oc.client_id=c.id
        and oc.status='OPEN'
        and s.status<>'DONE'
    );
  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;

do $do$
declare j record;
begin
  for j in select jobid from cron.job where jobname='onboarding-orphan-sweep' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule(
    'onboarding-orphan-sweep',
    '*/2 * * * *',
    'select agency_ops.repair_onboarding_lifecycle_mismatches(); select agency_ops.sweep_onboarding_orphans();'
  );
end
$do$;
