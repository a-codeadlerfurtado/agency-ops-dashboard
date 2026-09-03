-- Imobi-Board 0003 - operacoes transacionais (spec 19 / 35 / 73 / 102 / 108)
--
-- Por que RPC e nao 4 chamadas do frontend: mover um lead precisa escrever
-- opportunities + activities + domain_events atomicamente. Em REST isso vira
-- 3 requests, 3 round-trips e uma janela onde o historico fica inconsistente.
-- Aqui e uma transacao e um request.
--
-- Tambem e o que permite domain_events nao ter nenhum grant: so estas funcoes
-- SECURITY DEFINER escrevem nela.

-- --------------------------------------------------------- normalizacao
-- Implementacao unica, no banco: nao da para o frontend gravar um telefone
-- normalizado diferente do que a ingestao gravaria. O unique index de
-- contacts (spec 17) depende disso ser deterministico.
create or replace function imobi_board_priv.normalize_phone_br(p_phone text)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  d text;
begin
  if p_phone is null then return null; end if;
  d := regexp_replace(p_phone, '\D', '', 'g');

  -- tira o codigo do pais quando veio junto
  if length(d) in (12, 13) and left(d, 2) = '55' then
    d := substr(d, 3);
  end if;

  -- celular antigo sem o nono digito: 11 8888-7777 -> 11 98888-7777
  if length(d) = 10 and substr(d, 3, 1) in ('6', '7', '8', '9') then
    d := substr(d, 1, 2) || '9' || substr(d, 3);
  end if;

  if length(d) not in (10, 11) then
    return null;  -- numero invalido: nao participa da deduplicacao
  end if;

  return '55' || d;
end;
$fn$;

create or replace function imobi_board_priv.normalize_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select nullif(lower(btrim(p_email)), '');
$fn$;

-- --------------------------------------------- last_interaction_at (spec 23)
-- Trigger em vez de responsabilidade da aplicacao: qualquer caminho que grave
-- atividade (UI, RPC, ingestao, worker) mantem o campo correto. E o que faz a
-- varredura de leads esquecidos ser um index scan em vez de um agregado.
create or replace function imobi_board_priv.bump_last_interaction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update imobi_board.opportunities o
     set last_interaction_at = new.created_at,
         first_contact_at = coalesce(
           o.first_contact_at,
           case when new.type in ('CALL', 'WHATSAPP', 'EMAIL', 'MEETING')
                then new.created_at end
         )
   where o.id = new.opportunity_id;
  return null;
end;
$fn$;

create trigger activities_bump_interaction
  after insert on imobi_board.activities
  for each row execute function imobi_board_priv.bump_last_interaction();

-- ------------------------------------------------------- emit_event (35)
create or replace function imobi_board_priv.emit_event(
  p_tenant_id      uuid,
  p_event_type     text,
  p_aggregate_type text,
  p_aggregate_id   uuid,
  p_payload        jsonb default '{}'::jsonb
) returns void
language sql
security definer
set search_path = ''
as $fn$
  insert into imobi_board.domain_events
    (tenant_id, event_type, aggregate_type, aggregate_id, payload)
  values (p_tenant_id, p_event_type, p_aggregate_type, p_aggregate_id, p_payload);
$fn$;

-- ---------------------------------------------------- provision_tenant
-- Onboarding de imobiliaria: cria o tenant, torna quem chamou ADMIN e monta o
-- funil padrao da spec 18 em uma transacao.
create or replace function imobi_board.provision_tenant(
  p_name text,
  p_slug text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid      uuid := (select auth.uid());
  v_tenant   uuid;
  v_pipeline uuid;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;

  insert into imobi_board.tenants (name, slug)
  values (p_name, p_slug)
  returning id into v_tenant;

  insert into imobi_board.memberships (tenant_id, user_id, role)
  values (v_tenant, v_uid, 'ADMIN');

  insert into imobi_board.pipelines (tenant_id, name, is_default)
  values (v_tenant, 'Funil padrao', true)
  returning id into v_pipeline;

  insert into imobi_board.pipeline_stages (tenant_id, pipeline_id, name, kind, sort_order)
  values
    (v_tenant, v_pipeline, 'Novo',        'NEW',        0),
    (v_tenant, v_pipeline, 'Contatado',   'CONTACTED',  1),
    (v_tenant, v_pipeline, 'Qualificado', 'QUALIFIED',  2),
    (v_tenant, v_pipeline, 'Visita',      'VISIT',      3),
    (v_tenant, v_pipeline, 'Proposta',    'PROPOSAL',   4),
    (v_tenant, v_pipeline, 'Venda',       'WON',        5);

  return v_tenant;
end;
$fn$;

-- -------------------------------------------------- create_opportunity
-- Contato != oportunidade (spec 14). Faz find-or-create do contato pelo
-- telefone normalizado dentro do tenant e SEMPRE cria a oportunidade: um lead
-- repetido seis meses depois e uma oportunidade nova, nao um evento descartado
-- (spec 17).
create or replace function imobi_board.create_opportunity(
  p_tenant_id         uuid,
  p_full_name         text,
  p_phone             text default null,
  p_email             text default null,
  p_assigned_user_id  uuid default null,
  p_source            text default 'MANUAL',
  p_source_detail     text default null,
  p_attribution       jsonb default '{}'::jsonb,
  p_external_event_id text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid        uuid := (select auth.uid());
  v_is_admin   boolean;
  v_is_member  boolean;
  v_phone_n    text := imobi_board_priv.normalize_phone_br(p_phone);
  v_email_n    text := imobi_board_priv.normalize_email(p_email);
  v_contact    uuid;
  v_pipeline   uuid;
  v_stage      uuid;
  v_opp        uuid;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;

  select
    bool_or(m.role = 'ADMIN'),
    count(*) > 0
    into v_is_admin, v_is_member
  from imobi_board.memberships m
  where m.user_id = v_uid and m.tenant_id = p_tenant_id and m.status = 'ACTIVE';

  if not coalesce(v_is_member, false) then
    raise exception 'Voce nao pertence a esta imobiliaria.' using errcode = '42501';
  end if;

  -- BROKER so cria lead para si mesmo; ADMIN escolhe o responsavel.
  if not coalesce(v_is_admin, false) then
    p_assigned_user_id := v_uid;
  end if;

  if p_assigned_user_id is not null and not exists (
    select 1 from imobi_board.memberships m
    where m.user_id = p_assigned_user_id
      and m.tenant_id = p_tenant_id
      and m.status = 'ACTIVE'
  ) then
    raise exception 'Corretor nao pertence a esta imobiliaria ou esta inativo.'
      using errcode = '42501';
  end if;

  -- idempotencia de webhook (spec 64): evento repetido devolve o que ja existe.
  if p_external_event_id is not null then
    select o.id into v_opp
    from imobi_board.opportunities o
    where o.tenant_id = p_tenant_id
      and o.source = p_source
      and o.external_event_id = p_external_event_id;
    if v_opp is not null then
      return v_opp;
    end if;
  end if;

  -- find-or-create do contato, por tenant
  if v_phone_n is not null then
    select c.id into v_contact
    from imobi_board.contacts c
    where c.tenant_id = p_tenant_id and c.phone_normalized = v_phone_n;
  end if;

  if v_contact is null and v_email_n is not null then
    select c.id into v_contact
    from imobi_board.contacts c
    where c.tenant_id = p_tenant_id and c.email_normalized = v_email_n;
  end if;

  if v_contact is null then
    insert into imobi_board.contacts
      (tenant_id, full_name, phone, phone_normalized, email, email_normalized)
    values
      (p_tenant_id, p_full_name, p_phone, v_phone_n, p_email, v_email_n)
    returning id into v_contact;

    perform imobi_board_priv.emit_event(
      p_tenant_id, 'contact.created', 'contact', v_contact,
      jsonb_build_object('full_name', p_full_name)
    );
  else
    -- contato ja conhecido: completa lacunas sem sobrescrever o que ja havia.
    update imobi_board.contacts c
       set phone            = coalesce(c.phone, p_phone),
           phone_normalized = coalesce(c.phone_normalized, v_phone_n),
           email            = coalesce(c.email, p_email),
           email_normalized = coalesce(c.email_normalized, v_email_n)
     where c.id = v_contact;
  end if;

  select p.id into v_pipeline
  from imobi_board.pipelines p
  where p.tenant_id = p_tenant_id and p.is_default
  limit 1;

  if v_pipeline is null then
    raise exception 'Imobiliaria sem funil configurado.' using errcode = 'P0001';
  end if;

  select s.id into v_stage
  from imobi_board.pipeline_stages s
  where s.pipeline_id = v_pipeline
  order by s.sort_order
  limit 1;

  insert into imobi_board.opportunities (
    tenant_id, contact_id, assigned_user_id, pipeline_id, stage_id,
    source, source_detail,
    campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, form_id,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    external_source_id, external_event_id,
    first_assigned_at
  ) values (
    p_tenant_id, v_contact, p_assigned_user_id, v_pipeline, v_stage,
    p_source, p_source_detail,
    p_attribution ->> 'campaign_id',   p_attribution ->> 'campaign_name',
    p_attribution ->> 'adset_id',      p_attribution ->> 'adset_name',
    p_attribution ->> 'ad_id',         p_attribution ->> 'ad_name',
    p_attribution ->> 'form_id',
    p_attribution ->> 'utm_source',    p_attribution ->> 'utm_medium',
    p_attribution ->> 'utm_campaign',  p_attribution ->> 'utm_content',
    p_attribution ->> 'utm_term',
    p_attribution ->> 'external_source_id', p_external_event_id,
    case when p_assigned_user_id is not null then now() end
  )
  returning id into v_opp;

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (p_tenant_id, v_opp, 'SYSTEM',
          'Oportunidade criada. Origem: ' || p_source, v_uid);

  perform imobi_board_priv.emit_event(
    p_tenant_id, 'opportunity.created', 'opportunity', v_opp,
    jsonb_build_object('source', p_source, 'assigned_user_id', p_assigned_user_id)
  );

  if p_assigned_user_id is not null then
    perform imobi_board_priv.emit_event(
      p_tenant_id, 'opportunity.assigned', 'opportunity', v_opp,
      jsonb_build_object('assigned_user_id', p_assigned_user_id)
    );
  end if;

  return v_opp;
end;
$fn$;

-- --------------------------------------------- move_opportunity_stage (73)
create or replace function imobi_board.move_opportunity_stage(
  p_opportunity_id uuid,
  p_stage_id       uuid,
  p_note           text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_opp       imobi_board.opportunities%rowtype;
  v_kind      imobi_board.stage_kind;
  v_is_admin  boolean;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;

  -- trava a linha: dois arrastes simultaneos no Kanban nao se atropelam (spec 33)
  select * into v_opp
  from imobi_board.opportunities
  where id = p_opportunity_id
  for update;

  if not found then
    raise exception 'Oportunidade nao encontrada.' using errcode = 'P0002';
  end if;

  select exists (
    select 1 from imobi_board.memberships m
    where m.user_id = v_uid and m.tenant_id = v_opp.tenant_id
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) into v_is_admin;

  if not v_is_admin and v_opp.assigned_user_id is distinct from v_uid then
    raise exception 'Voce nao tem permissao sobre esta oportunidade.'
      using errcode = '42501';
  end if;

  select s.kind into v_kind
  from imobi_board.pipeline_stages s
  where s.id = p_stage_id and s.pipeline_id = v_opp.pipeline_id;

  if v_kind is null then
    raise exception 'Estagio nao pertence ao funil desta oportunidade.'
      using errcode = 'P0001';
  end if;

  if v_opp.stage_id = p_stage_id then
    return;  -- idempotente: soltar o card na mesma coluna nao gera historico
  end if;

  if v_kind = 'LOST' and coalesce(btrim(p_note), '') = '' then
    raise exception 'Informe o motivo da perda.' using errcode = 'P0001';
  end if;

  update imobi_board.opportunities o
     set stage_id     = p_stage_id,
         status       = case v_kind
                          when 'WON'  then 'WON'::imobi_board.opp_status
                          when 'LOST' then 'LOST'::imobi_board.opp_status
                          else 'OPEN'::imobi_board.opp_status
                        end,
         qualified_at = case when v_kind in ('QUALIFIED','VISIT','PROPOSAL','WON')
                             then coalesce(o.qualified_at, now()) else o.qualified_at end,
         closed_at    = case when v_kind in ('WON','LOST') then now() else null end,
         lost_reason  = case when v_kind = 'LOST' then p_note else null end
   where o.id = p_opportunity_id;

  insert into imobi_board.activities
    (tenant_id, opportunity_id, type, body, from_stage_id, to_stage_id, created_by)
  values
    (v_opp.tenant_id, p_opportunity_id, 'STATUS_CHANGE', p_note,
     v_opp.stage_id, p_stage_id, v_uid);

  perform imobi_board_priv.emit_event(
    v_opp.tenant_id, 'opportunity.stage_changed', 'opportunity', p_opportunity_id,
    jsonb_build_object('from_stage_id', v_opp.stage_id,
                       'to_stage_id', p_stage_id,
                       'kind', v_kind)
  );

  if v_kind = 'LOST' then
    perform imobi_board_priv.emit_event(
      v_opp.tenant_id, 'opportunity.lost', 'opportunity', p_opportunity_id,
      jsonb_build_object('reason', p_note)
    );
  end if;
end;
$fn$;

-- --------------------------------------------------------------- grants
revoke execute on function imobi_board_priv.emit_event(uuid, text, text, uuid, jsonb) from public;
revoke execute on function imobi_board_priv.normalize_phone_br(text) from public;
revoke execute on function imobi_board_priv.normalize_email(text) from public;
revoke execute on function imobi_board_priv.bump_last_interaction() from public;

revoke execute on function imobi_board.provision_tenant(text, text) from public;
revoke execute on function imobi_board.create_opportunity(uuid, text, text, text, uuid, text, text, jsonb, text) from public;
revoke execute on function imobi_board.move_opportunity_stage(uuid, uuid, text) from public;

grant execute on function imobi_board.provision_tenant(text, text) to authenticated;
grant execute on function imobi_board.create_opportunity(uuid, text, text, text, uuid, text, text, jsonb, text) to authenticated;
grant execute on function imobi_board.move_opportunity_stage(uuid, uuid, text) to authenticated;
