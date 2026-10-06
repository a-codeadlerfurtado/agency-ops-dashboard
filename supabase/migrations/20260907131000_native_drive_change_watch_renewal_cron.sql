do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname='drive-change-watch-renew' loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

select cron.schedule(
  'drive-change-watch-renew',
  '17 6 * * *',
  $cmd$
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/drive-change-webhook?action=renew',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-drive-watch-admin',(select decrypted_secret from vault.decrypted_secrets where name='drive_change_admin_token')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (
    select 1
    from agency_ops.drive_change_watch_state
    where account_key='lakassessoriadigital'
      and status in ('ACTIVE','ERROR')
      and channel_expires_at is not null
      and channel_expires_at < now() + interval '36 hours'
  );
  $cmd$
);
