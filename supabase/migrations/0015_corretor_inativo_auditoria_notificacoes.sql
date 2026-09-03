-- Imobi-Board 0015 - fecha lacunas encontradas na auditoria da V1
--
-- 1. BUG: distribuir() so olhava queue_members.active e ignorava
--    memberships.status. Um corretor desativado continuava recebendo lead - e
--    como a RLS nao devolve tenant para membership inativo, ele nao conseguia
--    nem ver o lead. Ficava invisivel ate o SLA estourar. (spec 26)
-- 2. audit_logs existia desde a 0001 e ninguem escrevia nela. (spec 58)
-- 3. Fila sem vinculo com empreendimento. (spec 29)
-- 4. Sem notificacoes internas. (spec 57)

-- ---------------------------------------------- 3. fila por empreendimento
alter table imobi_board.lead_queues
  add column development_id uuid references imobi_board.developments(id) on delete set null;
create index lead_queues_development_idx
  on imobi_board.lead_queues (development_id) where development_id is not null;

-- ------------------------------------------------- 4. notificacoes (spec 57)
-- Só eventos reais disparam notificacao. "Follow-up vencido" e "visita
-- proxima" dependem do relogio, e cria-las exigiria varredura periodica - o
-- que a spec 32 proibe. Esses dois continuam como contadores calculados no
-- painel do corretor, que e onde ele ja olha.
create table imobi_board.notifications (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references imobi_board.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  type        text not null,
  title       text not null,
  body        text,
  entity_type text,
  entity_id   uuid,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
-- indice so sobre o que ainda nao foi lido: fica minusculo
create index notifications_inbox_idx
  on imobi_board.notifications (user_id, created_at desc) where read_at is null;

alter table imobi_board.notifications enable row level security;
grant select, update on imobi_board.notifications to authenticated;

-- cada um so ve as proprias, e a unica coluna que muda e read_at
create policy notifications_select on imobi_board.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy notifications_marcar_lida on imobi_board.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create or replace function imobi_board_priv.notificar(
  p_tenant_id uuid, p_user_id uuid, p_type text, p_title text,
  p_body text default null, p_entity_type text default null, p_entity_id uuid default null
) returns void
language sql security definer set search_path = ''
as $fn$
  insert into imobi_board.notifications
    (tenant_id, user_id, type, title, body, entity_type, entity_id)
  select p_tenant_id, p_user_id, p_type, p_title, p_body, p_entity_type, p_entity_id
  where p_user_id is not null;
$fn$;

create or replace function imobi_board.marcar_notificacoes_lidas()
returns void language sql security definer set search_path = ''
as $fn$
  update imobi_board.notifications
     set read_at = now()
   where user_id = (select auth.uid()) and read_at is null;
$fn$;

-- ------------------------------------------------- 2. auditoria (spec 58)
-- Trigger em vez de responsabilidade da aplicacao: qualquer caminho que altere
-- a linha deixa rastro, inclusive RPC e service role.
create or replace function imobi_board_priv.auditar()
returns trigger
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_tenant uuid;
  v_id     uuid;
  v_antes  jsonb;
  v_depois jsonb;
begin
  v_antes  := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_depois := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_tenant := coalesce(v_depois ->> 'tenant_id', v_antes ->> 'tenant_id')::uuid;
  v_id     := coalesce(v_depois ->> 'id',        v_antes ->> 'id')::uuid;

  if v_tenant is null then
    return null;
  end if;

  -- UPDATE que so mexeu no updated_at nao vira linha de auditoria
  if tg_op = 'UPDATE' and v_antes - 'updated_at' = v_depois - 'updated_at' then
    return null;
  end if;

  insert into imobi_board.audit_logs
    (tenant_id, actor_user_id, action, entity_type, entity_id, before, after)
  values (v_tenant, (select auth.uid()), tg_op, tg_table_name, v_id,
          v_antes - 'updated_at', v_depois - 'updated_at');
  return null;
end;
$fn$;

create trigger memberships_audit   after insert or update or delete on imobi_board.memberships
  for each row execute function imobi_board_priv.auditar();
create trigger sales_audit         after insert or update or delete on imobi_board.sales
  for each row execute function imobi_board_priv.auditar();
create trigger proposals_audit     after insert or update or delete on imobi_board.proposals
  for each row execute function imobi_board_priv.auditar();
create trigger properties_audit    after insert or update or delete on imobi_board.properties
  for each row execute function imobi_board_priv.auditar();
create trigger lead_queues_audit   after insert or update or delete on imobi_board.lead_queues
  for each row execute function imobi_board_priv.auditar();
create trigger queue_members_audit after insert or update or delete on imobi_board.queue_members
  for each row execute function imobi_board_priv.auditar();

-- --------------------------------- 1. corretor inativo nao recebe lead (26)
create or replace function imobi_board_priv.distribuir(
  p_opportunity_id uuid,
  p_queue_id       uuid,
  p_tentativa      smallint default 1,
  p_excluir        uuid default null
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_fila    imobi_board.lead_queues%rowtype;
  v_membro  imobi_board.queue_members%rowtype;
  v_ativos  int;
  v_excluir uuid;
  v_assign  uuid;
  v_nome    text;
begin
  select * into v_fila from imobi_board.lead_queues
  where id = p_queue_id and status = 'ACTIVE';
  if not found then
    raise exception 'Fila inexistente ou inativa.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_queue_id::text, 0));

  -- "elegivel" = ativo na fila E ativo no quadro de pessoal. Estar na fila nao
  -- basta: corretor desativado nao consegue nem enxergar o lead (a RLS so
  -- devolve tenant para membership ATIVO), entao o lead ficaria invisivel.
  create temp table if not exists _elegiveis (
    user_id uuid, sort_order smallint) on commit drop;
  delete from _elegiveis;
  insert into _elegiveis (user_id, sort_order)
  select m.user_id, m.sort_order
  from imobi_board.queue_members m
  join imobi_board.memberships mb
    on mb.user_id = m.user_id and mb.tenant_id = v_fila.tenant_id
  where m.queue_id = p_queue_id and m.active and mb.status = 'ACTIVE';

  select count(*) into v_ativos from _elegiveis;
  if v_ativos = 0 then
    raise exception 'Fila sem corretor ativo.' using errcode = 'P0001';
  end if;

  -- com um unico elegivel, excluir alguem deixaria o lead sem destino
  v_excluir := case when v_ativos > 1 then p_excluir end;

  select e.user_id, e.sort_order into v_membro.user_id, v_membro.sort_order
  from _elegiveis e
  where e.sort_order > v_fila.cursor_sort_order
    and (v_excluir is null or e.user_id <> v_excluir)
  order by e.sort_order limit 1;

  if v_membro.user_id is null then
    select e.user_id, e.sort_order into v_membro.user_id, v_membro.sort_order
    from _elegiveis e
    where (v_excluir is null or e.user_id <> v_excluir)
    order by e.sort_order limit 1;
  end if;

  if v_membro.user_id is null then
    raise exception 'Fila sem corretor ativo.' using errcode = 'P0001';
  end if;

  update imobi_board.lead_queues
     set cursor_sort_order = v_membro.sort_order
   where id = p_queue_id;

  insert into imobi_board.lead_assignments
    (tenant_id, opportunity_id, queue_id, user_id, expires_at, attempt)
  values
    (v_fila.tenant_id, p_opportunity_id, p_queue_id, v_membro.user_id,
     now() + make_interval(secs => v_fila.acceptance_timeout_seconds), p_tentativa)
  returning id into v_assign;

  update imobi_board.opportunities
     set assigned_user_id  = v_membro.user_id,
         first_assigned_at = coalesce(first_assigned_at, now()),
         accepted_at       = null
   where id = p_opportunity_id;

  select c.full_name into v_nome
  from imobi_board.opportunities o
  join imobi_board.contacts c on c.id = o.contact_id
  where o.id = p_opportunity_id;

  perform imobi_board_priv.notificar(
    v_fila.tenant_id, v_membro.user_id, 'lead.atribuido',
    'Novo lead: ' || coalesce(v_nome, 'sem nome'),
    'Assuma em ate ' || (v_fila.acceptance_timeout_seconds / 60) || ' minutos.',
    'opportunity', p_opportunity_id);

  perform imobi_board_priv.emit_event(
    v_fila.tenant_id, 'opportunity.assigned', 'opportunity', p_opportunity_id,
    jsonb_build_object('assignment_id', v_assign, 'user_id', v_membro.user_id,
                       'queue_id', p_queue_id, 'attempt', p_tentativa));

  return v_assign;
end;
$fn$;

revoke execute on function imobi_board_priv.notificar(uuid, uuid, text, text, text, text, uuid) from public;
revoke execute on function imobi_board_priv.auditar() from public;
revoke execute on function imobi_board.marcar_notificacoes_lidas() from public;
grant execute on function imobi_board.marcar_notificacoes_lidas() to authenticated;
