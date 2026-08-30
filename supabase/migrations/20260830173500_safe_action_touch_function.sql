begin;

create or replace function agency_ops.touch_safe_action_updated_at()
returns trigger
language plpgsql
set search_path = agency_ops, pg_catalog
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function agency_ops.touch_safe_action_updated_at() from public, anon, authenticated;
grant execute on function agency_ops.touch_safe_action_updated_at() to service_role;

drop trigger if exists safe_action_requests_touch_updated_at on agency_ops.safe_action_requests;
create trigger safe_action_requests_touch_updated_at
before update on agency_ops.safe_action_requests
for each row execute function agency_ops.touch_safe_action_updated_at();

commit;
