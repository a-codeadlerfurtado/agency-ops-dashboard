-- CRM Comercial -> termos financeiros canônicos/auditáveis.
-- Os campos de fechamento já existem em crm.leads; esta migration apenas os
-- expõe ao dashboard, protege o fechamento incompleto e sincroniza um lead
-- fechado quando houver vínculo EXATO via agency_ops.clients.crm_lead_id.

create or replace view agency_ops.crm_preclients as
select
  l.id,
  l.name,
  l.company,
  l.owner_id,
  l.stage,
  l.estimated_value,
  l.source,
  l.created_at,
  l.updated_at,
  l.closed_at,
  extract(epoch from (now()-l.updated_at))/86400.0 as days_in_stage,
  (select max(a.created_at) from crm.lead_activities a where a.lead_id=l.id) as last_interaction,
  (select min(a.due_at) from crm.lead_activities a where a.lead_id=l.id and not a.done and a.due_at is not null) as next_action_at,
  (select a.content from crm.lead_activities a where a.lead_id=l.id and not a.done order by a.due_at nulls last,a.created_at desc limit 1) as next_action,
  l.closed_monthly_value,
  l.closed_setup_value,
  l.closed_term_months,
  l.closed_monthly_first_month,
  l.closed_setup_first_month,
  l.closed_setup_payment,
  l.closed_setup_installment_values
from crm.leads l
where l.archived_at is null
  and lower(coalesce(l.stage,'')) in ('proposta','negociacao','pre-assinatura','pré-assinatura','contrato enviado','assinatura');

grant select on agency_ops.crm_preclients to service_role;

create or replace function agency_ops.require_crm_closing_terms()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, crm, public
as $$
begin
  if lower(coalesce(new.stage,'')) = 'fechado' then
    if new.closed_monthly_value is null then
      raise exception 'Mensalidade é obrigatória para fechar uma oportunidade no CRM';
    end if;
    if new.closed_setup_value is null then
      raise exception 'Implementação é obrigatória para fechar uma oportunidade no CRM';
    end if;
    if new.closed_term_months is null or new.closed_term_months <= 0 then
      raise exception 'Prazo contratual é obrigatório para fechar uma oportunidade no CRM';
    end if;
    if nullif(trim(coalesce(new.closed_setup_payment,'')), '') is null then
      raise exception 'Forma de pagamento da implementação é obrigatória para fechar uma oportunidade no CRM';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists crm_require_closing_terms on crm.leads;
create trigger crm_require_closing_terms
before insert or update of stage, closed_monthly_value, closed_setup_value, closed_term_months, closed_setup_payment
on crm.leads
for each row execute function agency_ops.require_crm_closing_terms();

create or replace function agency_ops.sync_crm_closed_terms(p_lead_id uuid)
returns void
language plpgsql
security definer
set search_path = agency_ops, crm, public
as $$
declare
  v_lead crm.leads%rowtype;
  v_client_id uuid;
  v_source_at timestamptz;
  v_name text;
begin
  select * into v_lead from crm.leads where id = p_lead_id;
  if not found or lower(coalesce(v_lead.stage,'')) <> 'fechado' then
    return;
  end if;

  -- Só sincroniza fechamento completo. O trigger de validação impede novos
  -- fechamentos incompletos, mas esta guarda também protege dados históricos.
  if v_lead.closed_monthly_value is null
     or v_lead.closed_setup_value is null
     or v_lead.closed_term_months is null
     or nullif(trim(coalesce(v_lead.closed_setup_payment,'')), '') is null then
    return;
  end if;

  -- Regra de segurança: nada de aproximação por nome. O CRM só vira verdade
  -- financeira de um cliente quando existe vínculo EXATO pelo crm_lead_id.
  select c.id into v_client_id
  from agency_ops.clients c
  where c.crm_lead_id = p_lead_id
  limit 1;

  if v_client_id is null then
    return;
  end if;

  v_source_at := coalesce(v_lead.closed_at, v_lead.updated_at, now());
  v_name := coalesce(nullif(v_lead.company,''), nullif(v_lead.name,''), p_lead_id::text);

  insert into agency_ops.client_commercial_term_evidence
    (client_id, source_type, source_id, source_at, field_key, numeric_value, text_value, array_value,
     evidence_excerpt, confidence, verification_status, extracted_by, evidence_hash, metadata)
  values
    (v_client_id, 'CRM', p_lead_id::text, v_source_at, 'MONTHLY', v_lead.closed_monthly_value, null, null,
     'Fechamento confirmado no CRM Comercial: mensalidade cadastrada para '||v_name||'.', 1, 'CONFIRMED',
     'crm-closed-sync', md5(v_client_id::text||':'||p_lead_id::text||':MONTHLY'),
     jsonb_build_object('crm_lead_id',p_lead_id,'stage',v_lead.stage,'closed_at',v_lead.closed_at)),
    (v_client_id, 'CRM', p_lead_id::text, v_source_at, 'IMPLEMENTATION', v_lead.closed_setup_value, null, null,
     'Fechamento confirmado no CRM Comercial: implementação cadastrada para '||v_name||'.', 1, 'CONFIRMED',
     'crm-closed-sync', md5(v_client_id::text||':'||p_lead_id::text||':IMPLEMENTATION'),
     jsonb_build_object('crm_lead_id',p_lead_id,'stage',v_lead.stage,'closed_at',v_lead.closed_at)),
    (v_client_id, 'CRM', p_lead_id::text, v_source_at, 'TERM', v_lead.closed_term_months, null, null,
     'Fechamento confirmado no CRM Comercial: prazo contratual cadastrado para '||v_name||'.', 1, 'CONFIRMED',
     'crm-closed-sync', md5(v_client_id::text||':'||p_lead_id::text||':TERM'),
     jsonb_build_object('crm_lead_id',p_lead_id,'stage',v_lead.stage,'closed_at',v_lead.closed_at)),
    (v_client_id, 'CRM', p_lead_id::text, v_source_at, 'PAYMENT', null, v_lead.closed_setup_payment, v_lead.closed_setup_installment_values,
     'Fechamento confirmado no CRM Comercial: forma de pagamento da implementação cadastrada para '||v_name||'.', 1, 'CONFIRMED',
     'crm-closed-sync', md5(v_client_id::text||':'||p_lead_id::text||':PAYMENT'),
     jsonb_build_object('crm_lead_id',p_lead_id,'stage',v_lead.stage,'closed_at',v_lead.closed_at,
       'monthly_first_month',v_lead.closed_monthly_first_month,'setup_first_month',v_lead.closed_setup_first_month))
  on conflict (client_id, source_type, source_id, field_key) do update set
    source_at = excluded.source_at,
    numeric_value = excluded.numeric_value,
    text_value = excluded.text_value,
    array_value = excluded.array_value,
    evidence_excerpt = excluded.evidence_excerpt,
    confidence = excluded.confidence,
    verification_status = excluded.verification_status,
    extracted_by = excluded.extracted_by,
    evidence_hash = excluded.evidence_hash,
    metadata = excluded.metadata,
    updated_at = now();

  -- O CRM preenche somente lacunas da ficha canônica. Nunca sobrescreve um
  -- valor já confirmado por contrato, briefing, reunião validada ou ajuste manual.
  insert into agency_ops.client_commercial_terms
    (client_id, monthly_value, implementation_value, term_months, implementation_payment,
     implementation_installments, notes, source, source_crm_lead_id, updated_by)
  values
    (v_client_id, v_lead.closed_monthly_value, v_lead.closed_setup_value, v_lead.closed_term_months,
     v_lead.closed_setup_payment, v_lead.closed_setup_installment_values,
     'Valores de fechamento confirmados no CRM Comercial.', 'CRM', p_lead_id, 'CRM Comercial')
  on conflict (client_id) do update set
    monthly_value = coalesce(agency_ops.client_commercial_terms.monthly_value, excluded.monthly_value),
    implementation_value = coalesce(agency_ops.client_commercial_terms.implementation_value, excluded.implementation_value),
    term_months = coalesce(agency_ops.client_commercial_terms.term_months, excluded.term_months),
    implementation_payment = coalesce(agency_ops.client_commercial_terms.implementation_payment, excluded.implementation_payment),
    implementation_installments = coalesce(agency_ops.client_commercial_terms.implementation_installments, excluded.implementation_installments),
    source_crm_lead_id = coalesce(agency_ops.client_commercial_terms.source_crm_lead_id, excluded.source_crm_lead_id),
    notes = coalesce(agency_ops.client_commercial_terms.notes, excluded.notes),
    updated_at = now();
end
$$;

create or replace function agency_ops.sync_crm_closed_terms_trigger()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, crm, public
as $$
begin
  if lower(coalesce(new.stage,'')) = 'fechado' then
    perform agency_ops.sync_crm_closed_terms(new.id);
  end if;
  return new;
end
$$;

drop trigger if exists crm_sync_closed_commercial_terms on crm.leads;
create trigger crm_sync_closed_commercial_terms
after insert or update of stage, closed_monthly_value, closed_setup_value, closed_term_months,
  closed_setup_payment, closed_setup_installment_values
on crm.leads
for each row execute function agency_ops.sync_crm_closed_terms_trigger();

create or replace function agency_ops.sync_client_crm_terms_trigger()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, crm, public
as $$
begin
  if new.crm_lead_id is not null then
    perform agency_ops.sync_crm_closed_terms(new.crm_lead_id);
  end if;
  return new;
end
$$;

drop trigger if exists clients_sync_crm_commercial_terms on agency_ops.clients;
create trigger clients_sync_crm_commercial_terms
after insert or update of crm_lead_id
on agency_ops.clients
for each row
when (new.crm_lead_id is not null)
execute function agency_ops.sync_client_crm_terms_trigger();

-- Backfill seguro: somente leads fechados já vinculados por crm_lead_id podem
-- gerar evidência ou preencher lacunas canônicas.
do $$
declare r record;
begin
  for r in
    select l.id
    from crm.leads l
    join agency_ops.clients c on c.crm_lead_id = l.id
    where lower(coalesce(l.stage,'')) = 'fechado'
  loop
    perform agency_ops.sync_crm_closed_terms(r.id);
  end loop;
end
$$;
