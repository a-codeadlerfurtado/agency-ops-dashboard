create or replace function agency_ops.tg_weekly_report_client_name()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare v_name text;
begin
  select display_name into v_name from agency_ops.clients where id=new.client_id;
  new.context := coalesce(new.context,'{}'::jsonb) || jsonb_build_object('client_name',coalesce(v_name,'Cliente'));
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists weekly_report_client_name on agency_ops.weekly_commercial_reports;
create trigger weekly_report_client_name
before insert or update on agency_ops.weekly_commercial_reports
for each row execute function agency_ops.tg_weekly_report_client_name();

update agency_ops.weekly_commercial_reports r
set context=coalesce(r.context,'{}'::jsonb)||jsonb_build_object('client_name',c.display_name),updated_at=now()
from agency_ops.clients c
where c.id=r.client_id;
