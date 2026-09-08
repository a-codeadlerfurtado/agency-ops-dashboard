create or replace function agency_ops.onboarding_worker_cutover_controller()
returns void
language plpgsql
security definer
set search_path to 'agency_ops','cron','pg_catalog'
as $fn$
declare
  v_cfg_updated timestamptz;
  v_mode text;
begin
  select updated_at, value->>'mode'
    into v_cfg_updated, v_mode
  from agency_ops.worker_runtime_config
  where key='onboarding_consolidated';

  if v_mode <> 'execute' then
    return;
  end if;

  if exists (
    select 1
    from agency_ops.worker_runs
    where worker='leonardoimobi-onboarding-1'
      and task='consolidated_whatsapp_onboarding'
      and mode='execute'
      and status='ok'
      and finished_at >= v_cfg_updated
  ) then
    if exists (select 1 from cron.job where jobname='consolidated-whatsapp-onboarding') then
      perform cron.unschedule('consolidated-whatsapp-onboarding');
    end if;
    if exists (select 1 from cron.job where jobname='onboarding-worker-cutover-controller') then
      perform cron.unschedule('onboarding-worker-cutover-controller');
    end if;
  end if;
end;
$fn$;

create or replace function agency_ops.onboarding_worker_watchdog()
returns void
language plpgsql
security definer
set search_path to 'agency_ops','cron','pg_catalog'
as $fn$
declare
  v_mode text;
  v_last_ok timestamptz;
begin
  select value->>'mode' into v_mode
  from agency_ops.worker_runtime_config
  where key='onboarding_consolidated';

  if v_mode <> 'execute' then
    return;
  end if;

  if exists (select 1 from cron.job where jobname='consolidated-whatsapp-onboarding') then
    return;
  end if;

  select max(finished_at) into v_last_ok
  from agency_ops.worker_runs
  where worker='leonardoimobi-onboarding-1'
    and task='consolidated_whatsapp_onboarding'
    and mode='execute'
    and status='ok';

  if coalesce(v_last_ok,'1970-01-01'::timestamptz) < now() - interval '25 minutes' then
    perform agency_ops.sync_clients_from_whatsapp_onboarding();
    perform agency_ops.replay_early_onboarding_meet_evidence();
    perform agency_ops.scan_onboarding_whatsapp_status();
    perform agency_ops.run_onboarding_notification_engine();
  end if;
end;
$fn$;

update agency_ops.worker_runtime_config
set value = jsonb_build_object('mode','execute','interval_ms',900000),
    updated_at = now()
where key='onboarding_consolidated';

select cron.unschedule('onboarding-worker-cutover-controller')
where exists (select 1 from cron.job where jobname='onboarding-worker-cutover-controller');
select cron.schedule(
  'onboarding-worker-cutover-controller',
  '* * * * *',
  'select agency_ops.onboarding_worker_cutover_controller();'
);

select cron.unschedule('onboarding-worker-watchdog')
where exists (select 1 from cron.job where jobname='onboarding-worker-watchdog');
select cron.schedule(
  'onboarding-worker-watchdog',
  '6,11,16,21,26,31,36,41,46,51,56,1 * * * *',
  'select agency_ops.onboarding_worker_watchdog();'
);
