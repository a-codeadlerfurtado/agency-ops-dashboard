create or replace function agency_ops.guard_meta_gt_client_analysis_edit()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
declare
  v_status text;
begin
  select s.status into v_status
  from agency_ops.meta_gt_weekly_submissions s
  where s.run_id = new.run_id and s.gt_person = new.gt_person
  limit 1;
  if v_status is not null and v_status not in ('DRAFT','REVISION_REQUESTED') then
    raise exception 'META_GT_ANALYSIS_LOCKED';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_meta_gt_client_analysis_edit on agency_ops.meta_gt_client_analyses;
create trigger trg_guard_meta_gt_client_analysis_edit
before insert or update on agency_ops.meta_gt_client_analyses
for each row execute function agency_ops.guard_meta_gt_client_analysis_edit();

create or replace function agency_ops.guard_meta_gt_submission_content_edit()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
begin
  if old.status in ('SUBMITTED','REVIEWED')
     and new.status = old.status
     and (
       new.portfolio_summary is distinct from old.portfolio_summary or
       new.top_opportunities is distinct from old.top_opportunities or
       new.top_problems is distinct from old.top_problems or
       new.patterns_recognized is distinct from old.patterns_recognized or
       new.forecast_next_week is distinct from old.forecast_next_week
     ) then
    raise exception 'META_GT_ANALYSIS_LOCKED';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_meta_gt_submission_content_edit on agency_ops.meta_gt_weekly_submissions;
create trigger trg_guard_meta_gt_submission_content_edit
before update on agency_ops.meta_gt_weekly_submissions
for each row execute function agency_ops.guard_meta_gt_submission_content_edit();
