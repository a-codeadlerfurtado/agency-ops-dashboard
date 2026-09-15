select cron.alter_job(
  50,
  schedule := '* * * * *',
  command := $cmd$
    do $task_engine$
    declare
      v_secret text;
      v_has_backend boolean;
    begin
      v_secret := agency_ops.get_secret('TASK_ENGINE_CRON_SECRET');
      select
        exists (
          select 1 from agency_ops.automation_settings
          where key = 'AI_ASK_ENDPOINT_URL'
            and nullif(trim(both '"' from value::text), '') is not null
        )
        and exists (
          select 1 from agency_ops.automation_settings
          where key = 'AI_ASK_READ_SECRET'
            and nullif(trim(both '"' from value::text), '') is not null
        )
      into v_has_backend;

      if v_secret is not null
         and (
           coalesce(length(agency_ops.get_secret('OPENAI_API_KEY')), 0) > 0
           or v_has_backend
         ) then
        perform net.http_post(
          url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-task-engine?limite=1&modo=SHADOW',
          body := '{}'::jsonb,
          params := '{}'::jsonb,
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-task-engine-key', v_secret
          ),
          timeout_milliseconds := 60000
        );
      end if;
    end
    $task_engine$;
  $cmd$,
  active := true
);
