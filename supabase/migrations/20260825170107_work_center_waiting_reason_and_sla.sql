alter table agency_ops.work_items
  add column if not exists waiting_reason text,
  add column if not exists waiting_since timestamptz;

alter table agency_ops.work_items
  drop constraint if exists work_items_waiting_reason_check;
alter table agency_ops.work_items
  add constraint work_items_waiting_reason_check
  check (waiting_reason is null or waiting_reason in ('CLIENT','GT','CS','DESIGN','APPROVAL','TECHNICAL','OTHER'));

create or replace function agency_ops.normalize_work_item_wait_state()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
begin
  if new.status = 'WAITING' then
    if tg_op = 'INSERT' then
      new.waiting_since := coalesce(new.waiting_since, now());
    elsif old.status is distinct from 'WAITING'
       or old.waiting_reason is distinct from new.waiting_reason then
      new.waiting_since := coalesce(new.waiting_since, now());
    end if;
  else
    new.waiting_reason := null;
    new.waiting_since := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalize_work_item_wait_state on agency_ops.work_items;
create trigger trg_normalize_work_item_wait_state
before insert or update of status,waiting_reason,waiting_since
on agency_ops.work_items
for each row execute function agency_ops.normalize_work_item_wait_state();

create index if not exists work_items_open_target_due_idx
  on agency_ops.work_items(target_person,status,due_at)
  where status not in ('COMPLETED','DISMISSED');
