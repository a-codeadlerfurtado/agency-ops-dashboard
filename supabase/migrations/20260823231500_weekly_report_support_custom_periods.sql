alter table agency_ops.weekly_traffic_reports
  drop constraint if exists weekly_traffic_reports_client_id_week_end_key;

alter table agency_ops.weekly_traffic_reports
  add constraint weekly_traffic_reports_client_period_key
  unique (client_id, week_start, week_end);

create index if not exists weekly_traffic_reports_period_idx
  on agency_ops.weekly_traffic_reports (week_start desc, week_end desc);
