-- Radar worker scheduler. Small isolated queue; external provider remains kill-switched by config.
do $$
declare v_job bigint;
begin
  select jobid into v_job from cron.job where jobname='ad-radar-worker-v1' limit 1;
  if v_job is not null then perform cron.unschedule(v_job); end if;
end $$;

select cron.schedule(
  'ad-radar-worker-v1',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='projeto_url')
      || '/functions/v1/agency-ops-ad-radar-worker',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $cron$
);
