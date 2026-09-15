-- Preserve the proven automatic weekly worker while allowing CUSTOM reports to coexist.
-- WEEKLY rows keep week_start/week_end; CUSTOM rows use period_start/period_end and null legacy week fields.

alter table agency_ops.weekly_client_reports
  alter column week_start drop not null,
  alter column week_end drop not null;

-- Custom and weekly reports can both have version 1 for the same exact period.
drop index if exists agency_ops.weekly_client_reports_period_version_uidx;
create unique index weekly_client_reports_period_version_uidx
  on agency_ops.weekly_client_reports(client_id, period_start, period_end, report_kind, report_version);

-- Restore the conflict target used by the automatic Monday worker.
-- CUSTOM rows have week_end = null, so PostgreSQL permits any number of custom versions.
create unique index if not exists weekly_client_reports_client_week_uidx
  on agency_ops.weekly_client_reports(client_id, week_end);

create or replace function agency_ops.normalize_weekly_report_period_fields()
returns trigger
language plpgsql
set search_path to 'agency_ops','public'
as $$
begin
  if coalesce(new.report_kind, 'WEEKLY') = 'CUSTOM' then
    new.period_start := coalesce(new.period_start, new.week_start);
    new.period_end := coalesce(new.period_end, new.week_end);
    new.week_start := null;
    new.week_end := null;
  else
    new.report_kind := 'WEEKLY';
    new.generation_source := coalesce(new.generation_source, 'META_SNAPSHOT');
    new.period_start := coalesce(new.period_start, new.week_start);
    new.period_end := coalesce(new.period_end, new.week_end);
  end if;

  if new.period_start is null or new.period_end is null then
    raise exception 'report period is required';
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS trg_normalize_weekly_report_period_fields ON agency_ops.weekly_client_reports;
create trigger trg_normalize_weekly_report_period_fields
before insert or update of report_kind,week_start,week_end,period_start,period_end
on agency_ops.weekly_client_reports
for each row execute function agency_ops.normalize_weekly_report_period_fields();

-- Normalize any CUSTOM rows created between the two releases.
update agency_ops.weekly_client_reports
set week_start = null, week_end = null
where report_kind = 'CUSTOM' and (week_start is not null or week_end is not null);
