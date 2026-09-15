do $migration$
declare
  v_jobid bigint;
  v_command text;
begin
  select jobid, command
    into v_jobid, v_command
  from cron.job
  where jobname = 'task-engine-drain'
  limit 1;

  if v_jobid is null then
    raise exception 'task-engine-drain cron job not found';
  end if;

  v_command := replace(v_command, 'timeout_milliseconds := 60000', 'timeout_milliseconds := 145000');
  v_command := replace(v_command, 'timeout_milliseconds := 120000', 'timeout_milliseconds := 145000');

  perform cron.alter_job(
    job_id := v_jobid,
    command := v_command
  );
end
$migration$;
