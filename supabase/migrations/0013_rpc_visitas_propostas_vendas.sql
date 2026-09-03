-- Imobi-Board 0013 - operacoes de visita, proposta e venda
-- (spec 43-45, 80, 102)

-- helper interno: empurra a oportunidade para um estagio semantico, mas nunca
-- para tras. Agendar visita num lead que ja esta em Proposta nao o rebaixa.
create or replace function imobi_board_priv.avancar_para_kind(
  p_opportunity_id uuid,
  p_kind           imobi_board.stage_kind,
  p_uid            uuid
) returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_opp   imobi_board.opportunities%rowtype;
  v_atual smallint;
  v_alvo  imobi_board.pipeline_stages%rowtype;
begin
  select * into v_opp from imobi_board.opportunities where id = p_opportunity_id;

  select s.sort_order into v_atual from imobi_board.pipeline_stages s
  where s.id = v_opp.stage_id;

  select s.* into v_alvo from imobi_board.pipeline_stages s
  where s.pipeline_id = v_opp.pipeline_id and s.kind = p_kind
  limit 1;

  if not found or v_alvo.sort_order <= v_atual then
    return;
  end if;

  update imobi_board.opportunities
     set stage_id = v_alvo.id,
         qualified_at = coalesce(qualified_at, now())
   where id = p_opportunity_id;

  insert into imobi_board.activities
    (tenant_id, opportunity_id, type, body, from_stage_id, to_stage_id, created_by)
  values (v_opp.tenant_id, p_opportunity_id, 'STATUS_CHANGE',
          'Etapa avancada automaticamente.', v_opp.stage_id, v_alvo.id, p_uid);

  perform imobi_board_priv.emit_event(
    v_opp.tenant_id, 'opportunity.stage_changed', 'opportunity', p_opportunity_id,
    jsonb_build_object('from_stage_id', v_opp.stage_id, 'to_stage_id', v_alvo.id,
                       'kind', p_kind, 'automatico', true));
end;
$fn$;

-- confere se quem chamou manda nesta oportunidade
create or replace function imobi_board_priv.pode_operar(p_opportunity_id uuid)
returns imobi_board.opportunities
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_opp imobi_board.opportunities%rowtype;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;

  select * into v_opp from imobi_board.opportunities where id = p_opportunity_id;
  if not found then
    raise exception 'Oportunidade nao encontrada.' using errcode = 'P0002';
  end if;

  if v_opp.assigned_user_id is distinct from v_uid
     and not exists (
       select 1 from imobi_board.memberships m
       where m.user_id = v_uid and m.tenant_id = v_opp.tenant_id
         and m.status = 'ACTIVE' and m.role = 'ADMIN') then
    raise exception 'Voce nao tem permissao sobre esta oportunidade.'
      using errcode = '42501';
  end if;

  return v_opp;
end;
$fn$;

-- ------------------------------------------------------------- visitas
create or replace function imobi_board.agendar_visita(
  p_opportunity_id uuid,
  p_scheduled_at   timestamptz,
  p_property_id    uuid default null,
  p_notas          text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_opp imobi_board.opportunities%rowtype;
  v_id  uuid;
begin
  v_opp := imobi_board_priv.pode_operar(p_opportunity_id);

  if p_scheduled_at < now() - interval '1 day' then
    raise exception 'Data da visita esta no passado.' using errcode = 'P0001';
  end if;

  insert into imobi_board.visits
    (tenant_id, opportunity_id, contact_id, property_id, broker_id, scheduled_at, notes)
  values (v_opp.tenant_id, p_opportunity_id, v_opp.contact_id, p_property_id,
          coalesce(v_opp.assigned_user_id, v_uid), p_scheduled_at, p_notas)
  returning id into v_id;

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (v_opp.tenant_id, p_opportunity_id, 'VISIT',
          'Visita agendada para ' || to_char(p_scheduled_at at time zone 'America/Sao_Paulo',
                                             'DD/MM/YYYY HH24:MI')
          || coalesce('. ' || p_notas, ''), v_uid);

  perform imobi_board_priv.emit_event(
    v_opp.tenant_id, 'visit.created', 'visit', v_id,
    jsonb_build_object('opportunity_id', p_opportunity_id, 'scheduled_at', p_scheduled_at));

  perform imobi_board_priv.avancar_para_kind(p_opportunity_id, 'VISIT', v_uid);
  return v_id;
end;
$fn$;

create or replace function imobi_board.atualizar_visita(
  p_visit_id uuid,
  p_status   imobi_board.visit_status,
  p_notas    text default null
) returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_v   imobi_board.visits%rowtype;
begin
  select * into v_v from imobi_board.visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visita nao encontrada.' using errcode = 'P0002';
  end if;
  perform imobi_board_priv.pode_operar(v_v.opportunity_id);

  update imobi_board.visits
     set status = p_status, notes = coalesce(p_notas, notes)
   where id = p_visit_id;

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (v_v.tenant_id, v_v.opportunity_id, 'VISIT',
          'Visita ' || case p_status
            when 'COMPLETED' then 'realizada'
            when 'CANCELLED' then 'cancelada'
            when 'NO_SHOW'   then 'nao compareceu'
            else 'reagendada' end || coalesce('. ' || p_notas, ''), v_uid);

  perform imobi_board_priv.emit_event(
    v_v.tenant_id,
    case when p_status = 'COMPLETED' then 'visit.completed' else 'visit.updated' end,
    'visit', p_visit_id, jsonb_build_object('status', p_status));
end;
$fn$;

-- ------------------------------------------------------------ propostas
create or replace function imobi_board.criar_proposta(
  p_opportunity_id   uuid,
  p_offered_price    numeric,
  p_property_id      uuid default null,
  p_list_price       numeric default null,
  p_down_payment     numeric default null,
  p_financing_amount numeric default null,
  p_valid_until      date default null,
  p_notas            text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_opp imobi_board.opportunities%rowtype;
  v_id  uuid;
  v_lp  numeric;
begin
  v_opp := imobi_board_priv.pode_operar(p_opportunity_id);

  if p_offered_price is null or p_offered_price <= 0 then
    raise exception 'Informe o valor da proposta.' using errcode = 'P0001';
  end if;

  -- se nao vier o preco de tabela, pega do imovel: e o que permite calcular
  -- desconto depois sem depender de o corretor ter digitado
  v_lp := coalesce(p_list_price,
                   (select price from imobi_board.properties where id = p_property_id));

  insert into imobi_board.proposals
    (tenant_id, opportunity_id, contact_id, property_id, broker_id,
     list_price, offered_price, down_payment, financing_amount, valid_until, notes, status)
  values (v_opp.tenant_id, p_opportunity_id, v_opp.contact_id, p_property_id,
          coalesce(v_opp.assigned_user_id, v_uid),
          v_lp, p_offered_price, p_down_payment, p_financing_amount,
          p_valid_until, p_notas, 'DRAFT')
  returning id into v_id;

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (v_opp.tenant_id, p_opportunity_id, 'PROPOSAL',
          'Proposta criada: R$ ' || to_char(p_offered_price, 'FM999G999G999D00')
          || coalesce('. ' || p_notas, ''), v_uid);

  perform imobi_board_priv.emit_event(
    v_opp.tenant_id, 'proposal.created', 'proposal', v_id,
    jsonb_build_object('opportunity_id', p_opportunity_id, 'offered_price', p_offered_price));

  perform imobi_board_priv.avancar_para_kind(p_opportunity_id, 'PROPOSAL', v_uid);
  return v_id;
end;
$fn$;

create or replace function imobi_board.atualizar_proposta(
  p_proposal_id uuid,
  p_status      imobi_board.proposal_status,
  p_notas       text default null
) returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_p   imobi_board.proposals%rowtype;
begin
  select * into v_p from imobi_board.proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'Proposta nao encontrada.' using errcode = 'P0002';
  end if;
  perform imobi_board_priv.pode_operar(v_p.opportunity_id);

  update imobi_board.proposals
     set status = p_status, notes = coalesce(p_notas, notes)
   where id = p_proposal_id;

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (v_p.tenant_id, v_p.opportunity_id, 'PROPOSAL',
          'Proposta ' || case p_status
            when 'SENT'        then 'enviada ao cliente'
            when 'NEGOTIATING' then 'em negociacao'
            when 'ACCEPTED'    then 'ACEITA'
            when 'REJECTED'    then 'recusada'
            when 'CANCELLED'   then 'cancelada'
            else 'atualizada' end || coalesce('. ' || p_notas, ''), v_uid);

  perform imobi_board_priv.emit_event(
    v_p.tenant_id,
    case p_status when 'ACCEPTED' then 'proposal.accepted'
                  when 'REJECTED' then 'proposal.rejected'
                  when 'SENT'     then 'proposal.sent'
                  else 'proposal.updated' end,
    'proposal', p_proposal_id, jsonb_build_object('status', p_status));

  -- Proposta aceita NAO vira venda sozinha (spec 80). Sinaliza e para: quem
  -- registra a venda e uma pessoa, com o valor final na mao.
end;
$fn$;

-- ------------------------------------------------------------- vendas
create or replace function imobi_board.registrar_venda(
  p_opportunity_id uuid,
  p_sale_value     numeric,
  p_property_id    uuid default null,
  p_proposal_id    uuid default null,
  p_sold_at        timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_opp  imobi_board.opportunities%rowtype;
  v_prop uuid;
  v_id   uuid;
  v_won  imobi_board.pipeline_stages%rowtype;
begin
  v_opp := imobi_board_priv.pode_operar(p_opportunity_id);

  if p_sale_value is null or p_sale_value <= 0 then
    raise exception 'Informe o valor da venda.' using errcode = 'P0001';
  end if;

  if exists (select 1 from imobi_board.sales s
             where s.opportunity_id = p_opportunity_id and s.cancelled_at is null) then
    raise exception 'Esta oportunidade ja tem venda registrada.' using errcode = 'P0001';
  end if;

  v_prop := coalesce(p_property_id,
                     (select property_id from imobi_board.proposals where id = p_proposal_id),
                     v_opp.property_id);

  -- snapshot de atribuicao: copia, nao referencia (spec 45)
  insert into imobi_board.sales (
    tenant_id, opportunity_id, proposal_id, contact_id, property_id, broker_id,
    sale_value, sold_at,
    source, campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name
  ) values (
    v_opp.tenant_id, p_opportunity_id, p_proposal_id, v_opp.contact_id, v_prop,
    coalesce(v_opp.assigned_user_id, v_uid), p_sale_value, p_sold_at,
    v_opp.source, v_opp.campaign_id, v_opp.campaign_name,
    v_opp.adset_id, v_opp.adset_name, v_opp.ad_id, v_opp.ad_name
  ) returning id into v_id;

  if p_proposal_id is not null then
    update imobi_board.proposals set status = 'ACCEPTED' where id = p_proposal_id;
  end if;

  if v_prop is not null then
    update imobi_board.properties set status = 'SOLD' where id = v_prop;
  end if;

  select s.* into v_won from imobi_board.pipeline_stages s
  where s.pipeline_id = v_opp.pipeline_id and s.kind = 'WON' limit 1;

  update imobi_board.opportunities
     set status = 'WON', closed_at = p_sold_at, property_id = coalesce(v_prop, property_id),
         stage_id = coalesce(v_won.id, stage_id),
         qualified_at = coalesce(qualified_at, now())
   where id = p_opportunity_id;

  insert into imobi_board.activities
    (tenant_id, opportunity_id, type, body, from_stage_id, to_stage_id, created_by)
  values (v_opp.tenant_id, p_opportunity_id, 'STATUS_CHANGE',
          'VENDA registrada: R$ ' || to_char(p_sale_value, 'FM999G999G999D00'),
          v_opp.stage_id, coalesce(v_won.id, v_opp.stage_id), v_uid);

  perform imobi_board_priv.emit_event(
    v_opp.tenant_id, 'sale.created', 'sale', v_id,
    jsonb_build_object('opportunity_id', p_opportunity_id, 'sale_value', p_sale_value,
                       'campaign_id', v_opp.campaign_id, 'source', v_opp.source));

  return v_id;
end;
$fn$;

create or replace function imobi_board.cancelar_venda(
  p_sale_id uuid,
  p_motivo  text
) returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_s   imobi_board.sales%rowtype;
begin
  select * into v_s from imobi_board.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Venda nao encontrada.' using errcode = 'P0002';
  end if;
  if v_s.cancelled_at is not null then
    return;
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'Informe o motivo do cancelamento.' using errcode = 'P0001';
  end if;

  -- cancelar venda e ato de gestao, nao do corretor
  if not exists (select 1 from imobi_board.memberships m
                 where m.user_id = v_uid and m.tenant_id = v_s.tenant_id
                   and m.status = 'ACTIVE' and m.role = 'ADMIN') then
    raise exception 'Apenas o administrador cancela uma venda.' using errcode = '42501';
  end if;

  update imobi_board.sales
     set cancelled_at = now(), cancel_reason = p_motivo where id = p_sale_id;

  if v_s.property_id is not null then
    update imobi_board.properties set status = 'AVAILABLE' where id = v_s.property_id;
  end if;

  update imobi_board.opportunities
     set status = 'OPEN', closed_at = null where id = v_s.opportunity_id;

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (v_s.tenant_id, v_s.opportunity_id, 'SYSTEM',
          'Venda cancelada. Motivo: ' || p_motivo, v_uid);

  perform imobi_board_priv.emit_event(
    v_s.tenant_id, 'sale.cancelled', 'sale', p_sale_id,
    jsonb_build_object('motivo', p_motivo));
end;
$fn$;

-- ----------------------------------------------- spec 80: venda e explicita
-- Arrastar o card para "Venda" nao fecha negocio. O estagio WON so e alcancado
-- por registrar_venda(), que exige valor.
create or replace function imobi_board.move_opportunity_stage(
  p_opportunity_id uuid, p_stage_id uuid, p_note text default null
) returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_opp imobi_board.opportunities%rowtype;
  v_kind imobi_board.stage_kind;
  v_is_admin boolean;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode = '28000';
  end if;

  select * into v_opp from imobi_board.opportunities
  where id = p_opportunity_id for update;
  if not found then
    raise exception 'Oportunidade nao encontrada.' using errcode = 'P0002';
  end if;

  select exists (
    select 1 from imobi_board.memberships m
    where m.user_id = v_uid and m.tenant_id = v_opp.tenant_id
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) into v_is_admin;

  if not v_is_admin and v_opp.assigned_user_id is distinct from v_uid then
    raise exception 'Voce nao tem permissao sobre esta oportunidade.' using errcode = '42501';
  end if;

  select s.kind into v_kind from imobi_board.pipeline_stages s
  where s.id = p_stage_id and s.pipeline_id = v_opp.pipeline_id;

  if v_kind is null then
    raise exception 'Estagio nao pertence ao funil desta oportunidade.' using errcode = 'P0001';
  end if;

  if v_opp.stage_id = p_stage_id then return; end if;

  if v_kind = 'LOST' and coalesce(btrim(p_note), '') = '' then
    raise exception 'Informe o motivo da perda.' using errcode = 'P0001';
  end if;

  if v_kind = 'WON' and not exists (
       select 1 from imobi_board.sales s
       where s.opportunity_id = p_opportunity_id and s.cancelled_at is null) then
    raise exception 'Use "Registrar venda" para fechar: a venda precisa de valor.'
      using errcode = 'P0001';
  end if;

  update imobi_board.opportunities o
     set stage_id = p_stage_id,
         status = case v_kind
                    when 'WON'  then 'WON'::imobi_board.opp_status
                    when 'LOST' then 'LOST'::imobi_board.opp_status
                    else 'OPEN'::imobi_board.opp_status end,
         qualified_at = case when v_kind in ('QUALIFIED','VISIT','PROPOSAL','WON')
                             then coalesce(o.qualified_at, now()) else o.qualified_at end,
         closed_at = case when v_kind in ('WON','LOST') then now() else null end,
         lost_reason = case when v_kind = 'LOST' then p_note else null end
   where o.id = p_opportunity_id;

  insert into imobi_board.activities
    (tenant_id, opportunity_id, type, body, from_stage_id, to_stage_id, created_by)
  values (v_opp.tenant_id, p_opportunity_id, 'STATUS_CHANGE', p_note,
          v_opp.stage_id, p_stage_id, v_uid);

  perform imobi_board_priv.emit_event(
    v_opp.tenant_id, 'opportunity.stage_changed', 'opportunity', p_opportunity_id,
    jsonb_build_object('from_stage_id', v_opp.stage_id, 'to_stage_id', p_stage_id, 'kind', v_kind));

  if v_kind = 'LOST' then
    perform imobi_board_priv.emit_event(
      v_opp.tenant_id, 'opportunity.lost', 'opportunity', p_opportunity_id,
      jsonb_build_object('reason', p_note));
  end if;
end;
$fn$;

revoke execute on function imobi_board_priv.avancar_para_kind(uuid, imobi_board.stage_kind, uuid) from public;
revoke execute on function imobi_board_priv.pode_operar(uuid) from public;
revoke execute on function imobi_board.agendar_visita(uuid, timestamptz, uuid, text) from public;
revoke execute on function imobi_board.atualizar_visita(uuid, imobi_board.visit_status, text) from public;
revoke execute on function imobi_board.criar_proposta(uuid, numeric, uuid, numeric, numeric, numeric, date, text) from public;
revoke execute on function imobi_board.atualizar_proposta(uuid, imobi_board.proposal_status, text) from public;
revoke execute on function imobi_board.registrar_venda(uuid, numeric, uuid, uuid, timestamptz) from public;
revoke execute on function imobi_board.cancelar_venda(uuid, text) from public;

grant execute on function imobi_board.agendar_visita(uuid, timestamptz, uuid, text) to authenticated;
grant execute on function imobi_board.atualizar_visita(uuid, imobi_board.visit_status, text) to authenticated;
grant execute on function imobi_board.criar_proposta(uuid, numeric, uuid, numeric, numeric, numeric, date, text) to authenticated;
grant execute on function imobi_board.atualizar_proposta(uuid, imobi_board.proposal_status, text) to authenticated;
grant execute on function imobi_board.registrar_venda(uuid, numeric, uuid, uuid, timestamptz) to authenticated;
grant execute on function imobi_board.cancelar_venda(uuid, text) to authenticated;
