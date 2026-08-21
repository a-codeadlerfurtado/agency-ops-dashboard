create table if not exists agency_ops.diary_admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Adler e identificado pelo cadastro atual apenas para semear a relacao administrativa;
-- depois disso a autorizacao usa o UUID estavel do usuario, nao o nome.
insert into agency_ops.diary_admin_users(user_id)
select au.id
from auth.users au
join agency_ops.user_preferences up on up.user_key=au.id::text
where up.collaborator_person='Adler Furtado'
on conflict (user_id) do nothing;

create or replace function agency_ops.is_diary_admin()
returns boolean
language sql
stable
security definer
set search_path=pg_catalog,agency_ops
as $$ select exists(select 1 from agency_ops.diary_admin_users d where d.user_id=auth.uid()) $$;
revoke all on function agency_ops.is_diary_admin() from public;
grant execute on function agency_ops.is_diary_admin() to authenticated,service_role;

create table if not exists agency_ops.adjustment_tags (
  code text primary key,
  label text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into agency_ops.adjustment_tags(code,label) values
 ('VISUAL_IDENTITY','Identidade visual'),('WRONG_INFORMATION','Informação errada'),('PHOTO','Foto'),('COPY','Copy'),
 ('DEADLINE','Prazo'),('REWORK','Retrabalho'),('PRICE','Preço'),('APPROVAL','Aprovação')
on conflict (code) do update set label=excluded.label,active=true;

create table if not exists agency_ops.adjustment_log_tags (
  adjustment_id bigint not null references agency_ops.client_adjustments(id) on delete cascade,
  tag_code text not null references agency_ops.adjustment_tags(code) on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  primary key(adjustment_id,tag_code)
);

create table if not exists agency_ops.adjustment_attachments (
  id bigint generated always as identity primary key,
  adjustment_id bigint not null references agency_ops.client_adjustments(id) on delete cascade,
  kind text not null default 'LINK',
  url text,
  file_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists agency_ops.adjustment_change_log (
  id bigint generated always as identity primary key,
  adjustment_id bigint not null,
  operation text not null check(operation in ('UPDATE','DELETE')),
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null,
  old_data jsonb,
  new_data jsonb
);

create or replace function agency_ops.track_adjustment_change()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,agency_ops
as $$
begin
  if tg_op='UPDATE' then
    insert into agency_ops.adjustment_change_log(adjustment_id,operation,changed_by,old_data,new_data)
    values(old.id,'UPDATE',new.updated_by,to_jsonb(old),to_jsonb(new));
    return new;
  elsif tg_op='DELETE' then
    insert into agency_ops.adjustment_change_log(adjustment_id,operation,changed_by,old_data,new_data)
    values(old.id,'DELETE',old.updated_by,to_jsonb(old),null);
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_client_adjustments_audit on agency_ops.client_adjustments;
create trigger trg_client_adjustments_audit
after update or delete on agency_ops.client_adjustments
for each row execute function agency_ops.track_adjustment_change();

-- Defesa em profundidade caso essas tabelas venham a ser expostas diretamente no futuro.
alter table agency_ops.client_adjustments enable row level security;
drop policy if exists adjustment_owner_select on agency_ops.client_adjustments;
create policy adjustment_owner_select on agency_ops.client_adjustments for select to authenticated
using(author_user_id=auth.uid() or agency_ops.is_diary_admin());
drop policy if exists adjustment_owner_insert on agency_ops.client_adjustments;
create policy adjustment_owner_insert on agency_ops.client_adjustments for insert to authenticated
with check(author_user_id=auth.uid());
drop policy if exists adjustment_owner_update on agency_ops.client_adjustments;
create policy adjustment_owner_update on agency_ops.client_adjustments for update to authenticated
using(author_user_id=auth.uid() or agency_ops.is_diary_admin())
with check(author_user_id=auth.uid() or agency_ops.is_diary_admin());

alter table agency_ops.task_log_entries enable row level security;
drop policy if exists tasklog_owner_select on agency_ops.task_log_entries;
create policy tasklog_owner_select on agency_ops.task_log_entries for select to authenticated
using(author_user_id=auth.uid() or agency_ops.is_diary_admin());
drop policy if exists tasklog_owner_insert on agency_ops.task_log_entries;
create policy tasklog_owner_insert on agency_ops.task_log_entries for insert to authenticated
with check(author_user_id=auth.uid() and user_key=auth.uid()::text);

alter table agency_ops.adjustment_tags enable row level security;
alter table agency_ops.adjustment_log_tags enable row level security;
alter table agency_ops.adjustment_attachments enable row level security;
alter table agency_ops.adjustment_change_log enable row level security;
alter table agency_ops.diary_admin_users enable row level security;

-- Aplicacao atual passa exclusivamente pela Edge Function/RPC. Nenhum browser recebe acesso direto.
revoke all on agency_ops.client_adjustments,agency_ops.task_log_entries,agency_ops.adjustment_log_tags,
  agency_ops.adjustment_attachments,agency_ops.adjustment_change_log,agency_ops.diary_admin_users
from anon,authenticated;
grant select,insert,update,delete on agency_ops.client_adjustments,agency_ops.task_log_entries,
  agency_ops.adjustment_log_tags,agency_ops.adjustment_attachments,agency_ops.adjustment_change_log to service_role;
grant select on agency_ops.adjustment_categories,agency_ops.adjustment_subcategories,agency_ops.adjustment_tags,agency_ops.diary_admin_users to service_role;
grant usage,select on all sequences in schema agency_ops to service_role;
