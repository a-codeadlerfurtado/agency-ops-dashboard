do $$
begin
  if not exists (select 1 from vault.secrets where name = 'TASK_ENGINE_CRON_SECRET') then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'TASK_ENGINE_CRON_SECRET',
      'Internal key for agency-ops-task-engine cron invocations'
    );
  end if;
end
$$;
