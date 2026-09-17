-- Reduce pg_cron connection bursts that were causing intermittent `job startup timeout`
-- and keep the dashboard operational snapshot significantly fresher.
--
-- Snapshot refresh: hourly -> every 5 minutes, offset from the busiest minute marks.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'agency_ops_snapshot_refresh'),
  schedule := '2,7,12,17,22,27,32,37,42,47,52,57 * * * *'
);

-- ClickUp webhook watchdog is a recovery guard, not the primary sync path.
-- Running it every minute added unnecessary connection churn; every 5 minutes is enough
-- while preserving fast self-healing.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'clickup_webhook_self_heal'),
  schedule := '3,8,13,18,23,28,33,38,43,48,53,58 * * * *'
);

-- Meeting-ready retries do not need a database connection every minute.
-- Keep retries quick while cutting this cron's connection pressure in half.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'meeting_ready_notifier_v2_retry'),
  schedule := '1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31,33,35,37,39,41,43,45,47,49,51,53,55,57,59 * * * *'
);
