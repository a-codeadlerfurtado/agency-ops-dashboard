-- Imobi-Board 0049 - perfil Master interno
-- O Master continua sendo um usuario Auth normal, mas recebe memberships
-- ADMIN internas em todos os tenants. Essas memberships ficam invisiveis
-- para clientes e nao entram nos totais exibidos pela operacao.

alter table imobi_board.memberships
  add column if not exists is_internal boolean not null default false;

alter table imobi_board.operadores
  add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table imobi_board.operadores
  add column if not exists master_access boolean not null default false;

create unique index if not exists operadores_user_id_key
  on imobi_board.operadores (user_id)
  where user_id is not null;

create or replace function imobi_board_priv.e_master()
returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1
    from imobi_board.operadores o
    where o.email = lower((select auth.jwt() ->> 'email'))
      and o.master_access
      and o.user_id = (select auth.uid())
  );
$fn$;

revoke execute on function imobi_board_priv.e_master() from public;
grant execute on function imobi_board_priv.e_master() to authenticated;

create or replace function imobi_board.sou_master()
returns boolean
language sql stable security definer set search_path = ''
as $fn$ select imobi_board_priv.e_master(); $fn$;

revoke execute on function imobi_board.sou_master() from public;
grant execute on function imobi_board.sou_master() to authenticated;

create or replace function imobi_board_priv.sync_master_operator_memberships()
returns trigger
language plpgsql security definer set search_path = ''
as $fn$
begin
  if tg_op = 'UPDATE'
     and old.user_id is not null
     and (new.user_id is distinct from old.user_id or not new.master_access) then
    delete from imobi_board.memberships
     where user_id = old.user_id and is_internal;
  end if;

  if new.master_access and new.user_id is not null then
    insert into imobi_board.memberships
      (tenant_id, user_id, role, status, is_internal)
    select t.id, new.user_id, 'ADMIN', 'ACTIVE', true
      from imobi_board.tenants t
    on conflict (tenant_id, user_id) do update
      set role = 'ADMIN', status = 'ACTIVE', is_internal = true, updated_at = now();
  end if;

  return new;
end;
$fn$;

drop trigger if exists operadores_sync_master_memberships on imobi_board.operadores;
create trigger operadores_sync_master_memberships
after insert or update of user_id, master_access
on imobi_board.operadores
for each row execute function imobi_board_priv.sync_master_operator_memberships();

create or replace function imobi_board_priv.sync_master_new_tenant()
returns trigger
language plpgsql security definer set search_path = ''
as $fn$
begin
  insert into imobi_board.memberships
    (tenant_id, user_id, role, status, is_internal)
  select new.id, o.user_id, 'ADMIN', 'ACTIVE', true
    from imobi_board.operadores o
   where o.master_access and o.user_id is not null
  on conflict (tenant_id, user_id) do update
    set role = 'ADMIN', status = 'ACTIVE', is_internal = true, updated_at = now();
  return new;
end;
$fn$;

drop trigger if exists tenants_sync_master_memberships on imobi_board.tenants;
create trigger tenants_sync_master_memberships
after insert on imobi_board.tenants
for each row execute function imobi_board_priv.sync_master_new_tenant();

create or replace function imobi_board_priv.tenant_peer_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(array_agg(distinct m.user_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.status = 'ACTIVE'
    and (not m.is_internal or imobi_board_priv.e_master())
    and m.tenant_id in (
      select mine.tenant_id
      from imobi_board.memberships mine
      where mine.user_id = (select auth.uid())
        and mine.status = 'ACTIVE'
    );
$fn$;

drop policy if exists memberships_select on imobi_board.memberships;
create policy memberships_select on imobi_board.memberships
  for select to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
    and (not is_internal or (select imobi_board_priv.e_master()))
  );

drop policy if exists memberships_admin_insert on imobi_board.memberships;
create policy memberships_admin_insert on imobi_board.memberships
  for insert to authenticated
  with check (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    and (not is_internal or (select imobi_board_priv.e_master()))
  );

drop policy if exists memberships_admin_update on imobi_board.memberships;
create policy memberships_admin_update on imobi_board.memberships
  for update to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    and (not is_internal or (select imobi_board_priv.e_master()))
  )
  with check (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    and (not is_internal or (select imobi_board_priv.e_master()))
  );

drop policy if exists memberships_admin_delete on imobi_board.memberships;
create policy memberships_admin_delete on imobi_board.memberships
  for delete to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    and (not is_internal or (select imobi_board_priv.e_master()))
  );

create or replace function imobi_board.imobiliarias()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare v_r jsonb;
begin
  if not imobi_board_priv.e_operador() then
    raise exception 'Somente a operacao ve esta lista.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x order by x->>'criada_em' desc), '[]'::jsonb) into v_r
  from (
    select jsonb_build_object(
      'id', t.id, 'nome', t.name, 'slug', t.slug, 'criada_em', t.created_at,
      'membros', (
        select count(*) from imobi_board.memberships m
        where m.tenant_id = t.id and m.status = 'ACTIVE' and not m.is_internal
      ),
      'leads', (select count(*) from imobi_board.opportunities o where o.tenant_id = t.id),
      'filas', (select count(*) from imobi_board.lead_queues q where q.tenant_id = t.id),
      'convites_pendentes', (
        select count(*) from imobi_board.invites i
        where i.tenant_id = t.id and i.accepted_at is null and i.revoked_at is null
      )
    ) as x
    from imobi_board.tenants t
  ) s;
  return v_r;
end;
$fn$;

create or replace function imobi_board.registrar_acesso_mestre(
  p_tenant uuid,
  p_acao text default 'ENTER'
) returns void
language plpgsql security definer set search_path = ''
as $fn$
begin
  if not imobi_board_priv.e_master() then
    raise exception 'Acesso exclusivo do Master.' using errcode = '42501';
  end if;

  if not exists (select 1 from imobi_board.tenants t where t.id = p_tenant) then
    raise exception 'Imobiliaria nao existe.' using errcode = 'P0002';
  end if;

  insert into imobi_board.audit_logs
    (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (
    p_tenant,
    (select auth.uid()),
    case when upper(coalesce(p_acao, 'ENTER')) = 'EXIT' then 'MASTER_EXIT' else 'MASTER_ENTER' end,
    'tenant',
    p_tenant,
    jsonb_build_object('email', lower((select auth.jwt() ->> 'email')))
  );
end;
$fn$;

revoke execute on function imobi_board.registrar_acesso_mestre(uuid, text) from public;
grant execute on function imobi_board.registrar_acesso_mestre(uuid, text) to authenticated;

comment on column imobi_board.memberships.is_internal is
  'Membership tecnica de contas internas; nao deve aparecer como pessoa da imobiliaria.';
comment on column imobi_board.operadores.master_access is
  'Quando true, o operador recebe acesso Master a todos os tenants.';
