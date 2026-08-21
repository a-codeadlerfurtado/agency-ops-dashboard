do $activate_task_engine_live$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'TASK_ENGINE_CLICKUP_LIST'
      and decrypted_secret = '901326095338'
  ) then
    raise exception 'TASK_ENGINE_CLICKUP_LIST must point to Tarefas - Time (901326095338) before enabling LIVE';
  end if;

  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'CLICKUP_API_TOKEN'
      and coalesce(length(decrypted_secret), 0) > 0
  ) then
    raise exception 'CLICKUP_API_TOKEN is not configured';
  end if;

  update cron.job
  set command = replace(command, 'modo=SHADOW', 'modo=LIVE')
  where jobid = 50
    and command like '%agency-ops-task-engine%';

  if not exists (
    select 1
    from cron.job
    where jobid = 50
      and active = true
      and command like '%modo=LIVE%'
  ) then
    raise exception 'Task Engine cron was not switched to LIVE';
  end if;
end
$activate_task_engine_live$;
