-- Cut over check-overdue from recurring Supabase Edge invocation to the external
-- LeonardoImobi agency processor. The legacy Edge Function stays deployed as rollback.

update agency_ops.worker_runtime_config
set value = jsonb_set(coalesce(value, '{}'::jsonb), '{mode}', '"execute"'::jsonb, true),
    updated_at = now()
where key = 'check_overdue';

-- Stop the constant legacy invocation. The watchdog below can still invoke it on demand.
do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname = 'check-overdue-1min' loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

-- Lightweight DB-local cleanup replaces the cleanup that used to run on every
-- check-overdue Edge invocation.
do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname = 'sdr-envios-bot-cleanup-hourly' loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

select cron.schedule(
  'sdr-envios-bot-cleanup-hourly',
  '17 * * * *',
  $cron$
    delete from sdr_monitor.envios_bot
    where criado_em < now() - interval '24 hours';
  $cron$
);

-- Safety net: only call the legacy function when execute mode is enabled and the
-- external worker has gone more than 10 minutes without a successful cycle.
do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname = 'check-overdue-worker-watchdog' loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

select cron.schedule(
  'check-overdue-worker-watchdog',
  '4,9,14,19,24,29,34,39,44,49,54,59 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'projeto_url')
           || '/functions/v1/check-overdue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  )
  where (select value->>'mode'
         from agency_ops.worker_runtime_config
         where key = 'check_overdue') = 'execute'
    and coalesce(
      (select max(finished_at)
       from agency_ops.worker_runs
       where worker = 'leonardoimobi-primary-1'
         and task = 'check_overdue'
         and mode = 'execute'
         and status = 'ok'),
      '1970-01-01'::timestamptz
    ) < now() - interval '10 minutes';
  $cron$
);
