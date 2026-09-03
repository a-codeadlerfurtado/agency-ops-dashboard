-- Imobi-Board 0002 - RLS (spec PASSO 5, secoes 9 / 59 / 60 / 61)
--
-- Estrategia de custo: cada policy chama helpers STABLE SECURITY DEFINER
-- envolvidos em (select ...). O planner os transforma em InitPlan e executa
-- UMA vez por query, nao uma vez por linha. Sem isso, RLS multi-tenant custa
-- 5-10x mais CPU - e aqui a CPU e compartilhada com a operacao do imobi-pro.
--
-- SECURITY DEFINER ignora RLS das tabelas que le por dentro; por isso o filtro
-- por auth.uid() esta explicito no corpo de cada funcao.

-- ------------------------------------------------------------- helpers
grant usage on schema imobi_board_priv to authenticated;

-- tenants em que sou membro ativo (ADMIN ou BROKER)
create or replace function imobi_board_priv.current_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'ACTIVE';
$fn$;

-- subconjunto dos anteriores em que sou ADMIN
create or replace function imobi_board_priv.admin_tenant_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'ACTIVE'
    and m.role = 'ADMIN';
$fn$;

-- usuarios que dividem tenant comigo (inclui eu mesmo). Usado so em profiles,
-- para a UI conseguir mostrar o nome do corretor sem vazar quem e de outro tenant.
create or replace function imobi_board_priv.tenant_peer_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(array_agg(distinct m.user_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.status = 'ACTIVE'
    and m.tenant_id in (
      select mine.tenant_id
      from imobi_board.memberships mine
      where mine.user_id = (select auth.uid())
        and mine.status = 'ACTIVE'
    );
$fn$;

-- o contato tem alguma oportunidade minha?
create or replace function imobi_board_priv.owns_contact(p_contact_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from imobi_board.opportunities o
    where o.contact_id = p_contact_id
      and o.assigned_user_id = (select auth.uid())
  );
$fn$;

-- a oportunidade esta atribuida a mim?
create or replace function imobi_board_priv.owns_opportunity(p_opportunity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from imobi_board.opportunities o
    where o.id = p_opportunity_id
      and o.assigned_user_id = (select auth.uid())
  );
$fn$;

-- funcoes recebem EXECUTE para PUBLIC por padrao no Postgres: revogar e liberar
-- so o que a policy precisa. anon nunca executa nada aqui.
revoke execute on all functions in schema imobi_board_priv from public;
grant execute on function imobi_board_priv.current_tenant_ids()          to authenticated;
grant execute on function imobi_board_priv.admin_tenant_ids()            to authenticated;
grant execute on function imobi_board_priv.tenant_peer_ids()             to authenticated;
grant execute on function imobi_board_priv.owns_contact(uuid)            to authenticated;
grant execute on function imobi_board_priv.owns_opportunity(uuid)        to authenticated;

-- indice que serve owns_contact() e a ficha do lead ao mesmo tempo.
drop index if exists imobi_board.opportunities_contact_idx;
create index opportunities_contact_idx
  on imobi_board.opportunities (contact_id, assigned_user_id);

-- ------------------------------------------------------------- enable
alter table imobi_board.tenants         enable row level security;
alter table imobi_board.profiles        enable row level security;
alter table imobi_board.memberships     enable row level security;
alter table imobi_board.contacts        enable row level security;
alter table imobi_board.pipelines       enable row level security;
alter table imobi_board.pipeline_stages enable row level security;
alter table imobi_board.opportunities   enable row level security;
alter table imobi_board.activities      enable row level security;
alter table imobi_board.tasks           enable row level security;
alter table imobi_board.domain_events   enable row level security;
alter table imobi_board.audit_logs      enable row level security;

-- ------------------------------------------------------------- grants
-- anon nao recebe nada. DELETE quase nao existe de proposito: lead perdido vira
-- status LOST, historico nao se apaga.
grant select                 on imobi_board.tenants         to authenticated;
grant select, insert, update on imobi_board.profiles        to authenticated;
grant select, insert, update, delete on imobi_board.memberships to authenticated;
grant select, insert, update on imobi_board.contacts        to authenticated;
grant select, insert, update, delete on imobi_board.pipelines       to authenticated;
grant select, insert, update, delete on imobi_board.pipeline_stages to authenticated;
grant select, insert, update on imobi_board.opportunities   to authenticated;
grant select, insert         on imobi_board.activities      to authenticated;
grant select, insert, update, delete on imobi_board.tasks   to authenticated;
grant select                 on imobi_board.audit_logs      to authenticated;
-- domain_events: nenhum grant. Escrita so por RPC SECURITY DEFINER / service role.

-- ------------------------------------------------------------ tenants
create policy tenants_select on imobi_board.tenants
  for select to authenticated
  using (id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));

-- ----------------------------------------------------------- profiles
create policy profiles_select on imobi_board.profiles
  for select to authenticated
  using (id = any ((select imobi_board_priv.tenant_peer_ids())::uuid[]));

create policy profiles_insert_self on imobi_board.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy profiles_update_self on imobi_board.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- -------------------------------------------------------- memberships
create policy memberships_select on imobi_board.memberships
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));

-- so ADMIN mexe em quadro de pessoal. Fecha o teste 60: BROKER nao altera role.
create policy memberships_admin_insert on imobi_board.memberships
  for insert to authenticated
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

create policy memberships_admin_update on imobi_board.memberships
  for update to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

create policy memberships_admin_delete on imobi_board.memberships
  for delete to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

-- ----------------------------------------------------------- contacts
create policy contacts_select on imobi_board.contacts
  for select to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    or imobi_board_priv.owns_contact(id)
  );

-- WITH CHECK sempre reancorado em current_tenant_ids(): sem isso um BROKER
-- poderia escrever tenant_id de outra imobiliaria no payload (teste 114).
create policy contacts_insert on imobi_board.contacts
  for insert to authenticated
  with check (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));

create policy contacts_update on imobi_board.contacts
  for update to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    or imobi_board_priv.owns_contact(id)
  )
  with check (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));

-- ---------------------------------------------------- pipelines/stages
create policy pipelines_select on imobi_board.pipelines
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));

create policy pipelines_admin_write on imobi_board.pipelines
  for all to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

create policy pipeline_stages_select on imobi_board.pipeline_stages
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));

create policy pipeline_stages_admin_write on imobi_board.pipeline_stages
  for all to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

-- ------------------------------------------------------ opportunities
-- ADMIN ve o tenant inteiro; BROKER ve exclusivamente o que esta atribuido a ele.
-- Lead ainda na fila, sem dono, e invisivel para BROKER (spec 12).
create policy opportunities_select on imobi_board.opportunities
  for select to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    or assigned_user_id = (select auth.uid())
  );

-- BROKER so cria lead para si mesmo; ADMIN cria para quem quiser.
create policy opportunities_insert on imobi_board.opportunities
  for insert to authenticated
  with check (
    tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
    and (
      tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
      or assigned_user_id = (select auth.uid())
    )
  );

-- BROKER nao consegue repassar lead para colega nem tirar de si (spec 60),
-- e nao consegue mover para outro tenant.
create policy opportunities_update on imobi_board.opportunities
  for update to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    or assigned_user_id = (select auth.uid())
  )
  with check (
    tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
    and (
      tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
      or assigned_user_id = (select auth.uid())
    )
  );

-- --------------------------------------------------------- activities
-- Historico e append-only: sem UPDATE, sem DELETE, nem para ADMIN (spec 19).
create policy activities_select on imobi_board.activities
  for select to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    or imobi_board_priv.owns_opportunity(opportunity_id)
  );

create policy activities_insert on imobi_board.activities
  for insert to authenticated
  with check (
    tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
    and created_by = (select auth.uid())
    and (
      tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
      or imobi_board_priv.owns_opportunity(opportunity_id)
    )
  );

-- -------------------------------------------------------------- tasks
create policy tasks_select on imobi_board.tasks
  for select to authenticated
  using (
    assigned_user_id = (select auth.uid())
    or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
  );

create policy tasks_insert on imobi_board.tasks
  for insert to authenticated
  with check (
    tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
    and (
      tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
      or assigned_user_id = (select auth.uid())
    )
  );

create policy tasks_update on imobi_board.tasks
  for update to authenticated
  using (
    assigned_user_id = (select auth.uid())
    or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
  )
  with check (
    tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
    and (
      tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
      or assigned_user_id = (select auth.uid())
    )
  );

create policy tasks_delete on imobi_board.tasks
  for delete to authenticated
  using (
    assigned_user_id = (select auth.uid())
    or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
  );

-- --------------------------------------------------------- audit_logs
create policy audit_logs_admin_select on imobi_board.audit_logs
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

-- domain_events fica sem policy e sem grant: RLS ligada + zero policy = negado
-- para qualquer usuario. Escrita e leitura apenas server-side.
