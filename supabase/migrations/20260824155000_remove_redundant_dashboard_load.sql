-- Remove custo redundante das leituras mais frequentes do dashboard sem alterar funcionalidade.

create index if not exists idx_media_metrics_daily_date_desc
  on agency_ops.media_metrics_daily (date desc);

create index if not exists idx_client_health_scores_date_desc
  on agency_ops.client_health_scores (date desc, client_id);

create index if not exists idx_client_adjustments_occurred_desc
  on agency_ops.client_adjustments (occurred_at desc);

create index if not exists idx_task_log_entries_live_date_desc
  on agency_ops.task_log_entries (task_date desc)
  where deleted_at is null;

create index if not exists idx_platform_notifications_occurred_desc
  on agency_ops.platform_notifications (occurred_at desc);

create index if not exists idx_clickup_tasks_open_due
  on agency_ops.clickup_tasks (due_date asc nulls last)
  where is_closed = false;

create index if not exists idx_clickup_tasks_match_status
  on agency_ops.clickup_tasks (client_match_status);

-- Lotes de 1000 mantinham uma transacao do drain aberta por mais de um minuto.
-- A cadencia permanece a cada 10 minutos, mas em blocos menores para reservar
-- capacidade do banco para os usuarios do dashboard.
select cron.alter_job(
  job_id := 61,
  schedule := '1,11,21,31,41,51 * * * *',
  command := 'select agency_ops.zapi_direct_official_tick(250);'
);
