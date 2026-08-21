select cron.alter_job(
  50,
  schedule := '* * * * *',
  command := $cmd$
    do $task_engine$
    begin
      if coalesce(length(agency_ops.get_secret('OPENAI_API_KEY')), 0) > 0 then
        perform net.http_post(
          url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-task-engine',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body := '{}'::jsonb
        );
      end if;
    end
    $task_engine$;
  $cmd$,
  active := true
);