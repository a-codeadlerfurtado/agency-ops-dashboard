do $jobs$
declare r record;
begin
  for r in select jobid from cron.job where jobname in (
    'agency_ops_weekend_balance_1800',
    'agency_ops_weekend_balance_1830',
    'agency_ops_weekend_balance_1835'
  ) loop
    perform cron.unschedule(r.jobid);
  end loop;
end
$jobs$;

-- O scheduler deste projeto executa os crons em UTC.
-- 18:00 / 18:30 / 18:35 em America/Sao_Paulo correspondem a 21:00 / 21:30 / 21:35 UTC.
select cron.schedule('agency_ops_weekend_balance_1800', '0 21 * * 5', $$select agency_ops.generate_weekend_low_balance_alerts('18:00');$$);
select cron.schedule('agency_ops_weekend_balance_1830', '30 21 * * 5', $$select agency_ops.generate_weekend_low_balance_alerts('18:30');$$);
select cron.schedule('agency_ops_weekend_balance_1835', '35 21 * * 5', $$select agency_ops.generate_weekend_low_balance_alerts('18:35');$$);
