create table if not exists public.material_triage_signal (
  id smallint primary key check (id = 1),
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.material_triage_signal(id, version, updated_at)
values (1, 0, now())
on conflict (id) do nothing;

alter table public.material_triage_signal enable row level security;
revoke all on table public.material_triage_signal from public, anon;
grant select on table public.material_triage_signal to authenticated;
grant select, insert, update, delete on table public.material_triage_signal to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'material_triage_signal'
      and policyname = 'authenticated_can_read_material_triage_signal'
  ) then
    create policy authenticated_can_read_material_triage_signal
      on public.material_triage_signal
      for select
      to authenticated
      using (true);
  end if;
end $$;

create or replace function agency_ops.bump_material_triage_signal()
returns trigger
language plpgsql
security definer
set search_path = public, agency_ops
as $$
begin
  if (tg_op = 'INSERT' and new.type = 'MATERIAL_TRIAGE')
     or (tg_op = 'DELETE' and old.type = 'MATERIAL_TRIAGE')
     or (tg_op = 'UPDATE' and (new.type = 'MATERIAL_TRIAGE' or old.type = 'MATERIAL_TRIAGE')) then
    update public.material_triage_signal
       set version = version + 1,
           updated_at = now()
     where id = 1;
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function agency_ops.bump_material_triage_signal() from public, anon, authenticated;

drop trigger if exists trg_bump_material_triage_signal on agency_ops.work_items;
create trigger trg_bump_material_triage_signal
after insert or update or delete on agency_ops.work_items
for each row execute function agency_ops.bump_material_triage_signal();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'material_triage_signal'
  ) then
    execute 'alter publication supabase_realtime add table public.material_triage_signal';
  end if;
end $$;
