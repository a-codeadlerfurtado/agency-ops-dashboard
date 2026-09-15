do $$
declare r record;
begin
  for r in select jobid from cron.job where jobname = 'agency_ops_manager_radar_0900'
  loop
    perform cron.unschedule(r.jobid);
  end loop;
end $$;

-- cron.timezone is GMT. 09:00 America/Sao_Paulo (UTC-03) = 12:00 UTC.
select cron.schedule(
  'agency_ops_manager_radar_0900',
  '0 12 * * *',
  $$select agency_ops.invoke_manager_attention_radar('09:00');$$
);
