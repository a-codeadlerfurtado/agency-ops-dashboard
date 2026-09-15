-- Imobi-Board 0005 - filas, round robin e SLA (spec 27 / 28 / 30 / 31 / 33)
--
-- NOTA: imobi_board_priv.distribuir() e imobi_board.expirar_assignment() sao
-- redefinidas na migration 0006. Esta versao esta aqui por fidelidade
-- historica; o comportamento final e o da 0006.

create type imobi_board.queue_strategy   as enum ('ROUND_ROBIN');
create type imobi_board.assignment_status as enum ('PENDING','ACCEPTED','MISSED','REASSIGNED','CANCELLED');

create table imobi_board.lead_queues (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references imobi_board.tenants(id) on delete cascade,
  name        text not null,
  status      imobi_board.tenant_status not null default 'ACTIVE',
  strategy    imobi_board.queue_strategy not null default 'ROUND_ROBIN',
  acceptance_timeout_seconds int not null default 300
    check (acceptance_timeout_seconds between 30 and 86400),
  timezone    text not null default 'America/Sao_Paulo',
  working_hours jsonb not null default '{}'::jsonb,
  -- cursor do rodizio. Vive na fila, nao em memoria do worker: sobrevive a
  -- restart e nao depende de o Worker ser o mesmo isolate.
  cursor_sort_order smallint not null default -1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index lead_queues_tenant_idx on imobi_board.lead_queues (tenant_id);
create trigger lead_queues_touch before update on imobi_board.lead_queues
  for each row execute function imobi_board_priv.touch_updated_at();

create table imobi_board.queue_members (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references imobi_board.tenants(id) on delete cascade,
  queue_id   uuid not null references imobi_board.lead_queues(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  sort_order smallint not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (queue_id, user_id)
);
create index queue_members_rodizio_idx
  on imobi_board.queue_members (queue_id, sort_order) where active;

create table imobi_board.lead_assignments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references imobi_board.tenants(id) on delete cascade,
  opportunity_id uuid not null references imobi_board.opportunities(id) on delete cascade,
  queue_id       uuid references imobi_board.lead_queues(id) on delete set null,
  user_id        uuid not null references auth.users(id) on delete cascade,
  status         imobi_board.assignment_status not null default 'PENDING',
  assigned_at    timestamptz not null default now(),
  expires_at     timestamptz not null,
  accepted_at    timestamptz,
  resolved_at    timestamptz,
  attempt        smallint not null default 1
);
-- Trava de corrida (spec 33): uma oportunidade nao pode ter duas atribuicoes
-- pendentes ao mesmo tempo, aconteca o que acontecer na aplicacao.
create unique index lead_assignments_uma_pendente_uq
  on imobi_board.lead_assignments (opportunity_id) where status = 'PENDING';
create index lead_assignments_user_idx
  on imobi_board.lead_assignments (user_id, status, assigned_at desc);

alter table imobi_board.lead_queues      enable row level security;
alter table imobi_board.queue_members    enable row level security;
alter table imobi_board.lead_assignments enable row level security;

grant select, insert, update, delete on imobi_board.lead_queues     to authenticated;
grant select, insert, update, delete on imobi_board.queue_members   to authenticated;
grant select                         on imobi_board.lead_assignments to authenticated;

create policy lead_queues_select on imobi_board.lead_queues
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));
create policy lead_queues_admin on imobi_board.lead_queues
  for all to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

create policy queue_members_select on imobi_board.queue_members
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));
create policy queue_members_admin on imobi_board.queue_members
  for all to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

-- corretor ve as proprias atribuicoes; ADMIN ve as do tenant
create policy lead_assignments_select on imobi_board.lead_assignments
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
  );

-- ------------------------------------------------------------ round robin
-- pg_advisory_xact_lock por fila: duas ingestoes simultaneas serializam aqui e
-- ninguem le o mesmo cursor duas vezes. A trava cai sozinha no commit.
create or replace function imobi_board_priv.distribuir(
  p_opportunity_id uuid,
  p_queue_id       uuid,
  p_tentativa      smallint default 1
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_fila   imobi_board.lead_queues%rowtype;
  v_membro imobi_board.queue_members%rowtype;
  v_assign uuid;
begin
  select * into v_fila from imobi_board.lead_queues
  where id = p_queue_id and status = 'ACTIVE';
  if not found then
    raise exception 'Fila inexistente ou inativa.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_queue_id::text, 0));

  select m.* into v_membro
  from imobi_board.queue_members m
  where m.queue_id = p_queue_id and m.active
    and m.sort_order > v_fila.cursor_sort_order
  order by m.sort_order limit 1;

  if not found then
    select m.* into v_membro
    from imobi_board.queue_members m
    where m.queue_id = p_queue_id and m.active
    order by m.sort_order limit 1;
  end if;

  if not found then
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

  perform imobi_board_priv.emit_event(
    v_fila.tenant_id, 'opportunity.assigned', 'opportunity', p_opportunity_id,
    jsonb_build_object('assignment_id', v_assign, 'user_id', v_membro.user_id,
                       'queue_id', p_queue_id, 'attempt', p_tentativa));

  return v_assign;
end;
$fn$;

create or replace function imobi_board.distribuir_lead(
  p_opportunity_id uuid, p_queue_id uuid
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from imobi_board.opportunities where id = p_opportunity_id;
  if not exists (
    select 1 from imobi_board.memberships m
    where m.user_id = (select auth.uid()) and m.tenant_id = v_tenant
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) then
    raise exception 'Apenas o administrador distribui leads.' using errcode = '42501';
  end if;
  return imobi_board_priv.distribuir(p_opportunity_id, p_queue_id, 1);
end;
$fn$;

-- ------------------------------------------------------------------ aceite
create or replace function imobi_board.aceitar_lead(p_assignment_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_a   imobi_board.lead_assignments%rowtype;
begin
  select * into v_a from imobi_board.lead_assignments
  where id = p_assignment_id for update;

  if not found then
    raise exception 'Atribuicao nao encontrada.' using errcode = 'P0002';
  end if;
  if v_a.user_id <> v_uid then
    raise exception 'Esse lead nao foi atribuido a voce.' using errcode = '42501';
  end if;
  if v_a.status = 'ACCEPTED' then
    return;  -- idempotente: clicar duas vezes em "Assumir" nao e erro
  end if;
  if v_a.status <> 'PENDING' then
    raise exception 'Esse lead ja foi redistribuido.' using errcode = 'P0001';
  end if;

  update imobi_board.lead_assignments
     set status = 'ACCEPTED', accepted_at = now(), resolved_at = now()
   where id = p_assignment_id;

  update imobi_board.opportunities set accepted_at = now()
   where id = v_a.opportunity_id;

  perform imobi_board_priv.emit_event(
    v_a.tenant_id, 'opportunity.accepted', 'opportunity', v_a.opportunity_id,
    jsonb_build_object('assignment_id', p_assignment_id, 'user_id', v_uid));
end;
$fn$;

-- --------------------------------------------------------- expiracao de SLA
-- Chamada pelo Cloudflare Workflow ao acordar. Idempotente de proposito: o
-- Workflow pode reexecutar o passo e o resultado e o mesmo.
create or replace function imobi_board.expirar_assignment(p_assignment_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_a    imobi_board.lead_assignments%rowtype;
  v_novo uuid;
begin
  select * into v_a from imobi_board.lead_assignments
  where id = p_assignment_id for update;

  if not found then return jsonb_build_object('resultado', 'nao_encontrado'); end if;
  if v_a.status = 'ACCEPTED' then return jsonb_build_object('resultado', 'ja_aceito'); end if;
  if v_a.status <> 'PENDING' then
    return jsonb_build_object('resultado', 'ja_resolvido', 'status', v_a.status);
  end if;
  if now() < v_a.expires_at then
    return jsonb_build_object('resultado', 'ainda_no_prazo', 'expires_at', v_a.expires_at);
  end if;

  update imobi_board.lead_assignments
     set status = 'MISSED', resolved_at = now()
   where id = p_assignment_id;

  perform imobi_board_priv.emit_event(
    v_a.tenant_id, 'assignment.sla_missed', 'opportunity', v_a.opportunity_id,
    jsonb_build_object('assignment_id', p_assignment_id, 'user_id', v_a.user_id,
                       'attempt', v_a.attempt));

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (v_a.tenant_id, v_a.opportunity_id, 'SYSTEM',
          'SLA de aceite perdido. Lead redistribuido.', null);

  -- Redistribui, mas nao infinitamente: apos 5 voltas o lead volta para a fila
  -- sem dono, para o ADMIN resolver na mao.
  if v_a.queue_id is not null and v_a.attempt < 5 then
    begin
      v_novo := imobi_board_priv.distribuir(
        v_a.opportunity_id, v_a.queue_id, (v_a.attempt + 1)::smallint);
      update imobi_board.lead_assignments set status = 'REASSIGNED'
       where id = p_assignment_id;
      return jsonb_build_object('resultado', 'redistribuido', 'novo_assignment_id', v_novo);
    exception when others then
      update imobi_board.opportunities set assigned_user_id = null
       where id = v_a.opportunity_id;
      return jsonb_build_object('resultado', 'sem_corretor_disponivel', 'erro', sqlerrm);
    end;
  end if;

  update imobi_board.opportunities set assigned_user_id = null
   where id = v_a.opportunity_id;
  return jsonb_build_object('resultado', 'devolvido_a_fila');
end;
$fn$;

revoke execute on function imobi_board_priv.distribuir(uuid, uuid, smallint) from public;
revoke execute on function imobi_board.distribuir_lead(uuid, uuid) from public;
revoke execute on function imobi_board.aceitar_lead(uuid) from public;
revoke execute on function imobi_board.expirar_assignment(uuid) from public;

grant execute on function imobi_board.distribuir_lead(uuid, uuid) to authenticated;
grant execute on function imobi_board.aceitar_lead(uuid) to authenticated;
-- expirar_assignment e acao de sistema: so o Workflow, com service role.
grant execute on function imobi_board.expirar_assignment(uuid) to service_role;
