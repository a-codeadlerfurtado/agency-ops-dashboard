-- Fiscal identity + Autentique recovery hardening (2026-09-28)
-- 1) preserves explicit MANUAL_LINK contract/client associations during Autentique re-ingest
-- 2) adds missing fiscal identity alerts with automatic resolution
-- 3) adds hourly full contract reconciliation as a safety net for missed webhooks

CREATE OR REPLACE FUNCTION agency_ops.ingest_autentique_document(p_doc jsonb)
 RETURNS TABLE(contract_id uuid, acao text, match_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agency_ops', 'pg_temp'
AS $function$
declare
  v_doc_id     text := p_doc->>'id';
  v_name       text := p_doc->>'name';
  v_signers    jsonb := coalesce(p_doc->'signatures', '[]'::jsonb);
  v_updated    timestamptz := nullif(p_doc->>'updated_at','')::timestamptz;
  v_existing   agency_ops.client_contracts%rowtype;
  v_match      record;
  v_finished   boolean;
  v_id         uuid;
begin
  if v_doc_id is null then
    raise exception 'documento sem id' using errcode = '22023';
  end if;

  select * into v_existing from agency_ops.client_contracts where autentique_document_id = v_doc_id;

  -- Fora de ordem: evento antigo nao desfaz um estado mais novo.
  if found and v_existing.source_updated_at is not null and v_updated is not null
     and v_updated < v_existing.source_updated_at then
    return query select v_existing.id, 'IGNORADO_DESATUALIZADO', v_existing.client_match_status;
    return;
  end if;

  select * into v_match from agency_ops.match_contract_client(v_name, v_signers);

  -- Assinado por todos = documento concluido.
  v_finished := coalesce(
    (select bool_and((s->'signed'->>'created_at') is not null)
       from jsonb_array_elements(v_signers) s
      where jsonb_array_length(v_signers) > 0),
    false);

  insert into agency_ops.client_contracts as cc (
    autentique_document_id, document_name, client_name_raw,
    document_status, is_finished, finished_at,
    source_created_at, source_updated_at,
    signature_deadline_at,
    original_file_url, signed_file_url, signers, raw_document,
    client_id, client_match_status, client_match_confidence, client_match_source,
    term_source, term_confidence, extraction_status,
    first_seen_at, last_seen_at
  ) values (
    v_doc_id, v_name, v_name,
    case when v_finished then 'FINISHED' else 'PENDING_SIGNATURES' end,
    v_finished,
    case when v_finished then v_updated else null end,
    nullif(p_doc->>'created_at','')::timestamptz, v_updated,
    nullif(p_doc->>'expiration_at','')::timestamptz,   -- prazo de ASSINATURA
    p_doc#>>'{files,original}', p_doc#>>'{files,signed}',
    v_signers, p_doc,
    v_match.client_id, v_match.match_status, v_match.confidence, v_match.match_source,
    'TERM_UNKNOWN', 0, 'PENDING',                       -- vigencia nao inventada
    now(), now()
  )
  on conflict (autentique_document_id) do update set
    document_name           = excluded.document_name,
    document_status         = excluded.document_status,
    is_finished             = excluded.is_finished,
    finished_at             = coalesce(excluded.finished_at, cc.finished_at),
    source_updated_at       = excluded.source_updated_at,
    signature_deadline_at   = excluded.signature_deadline_at,
    original_file_url       = excluded.original_file_url,
    signed_file_url         = excluded.signed_file_url,
    signers                 = excluded.signers,
    raw_document            = excluded.raw_document,
    -- Vinculo confirmado a mao nunca e' rebaixado por um re-processamento.
    client_id               = case when (cc.client_match_status = 'MANUAL' or cc.client_match_source in ('MANUAL','MANUAL_LINK')) then cc.client_id else excluded.client_id end,
    client_match_status     = case when (cc.client_match_status = 'MANUAL' or cc.client_match_source in ('MANUAL','MANUAL_LINK')) then cc.client_match_status else excluded.client_match_status end,
    client_match_confidence = case when (cc.client_match_status = 'MANUAL' or cc.client_match_source in ('MANUAL','MANUAL_LINK')) then cc.client_match_confidence else excluded.client_match_confidence end,
    client_match_source     = case when (cc.client_match_status = 'MANUAL' or cc.client_match_source in ('MANUAL','MANUAL_LINK')) then cc.client_match_source else excluded.client_match_source end,
    last_seen_at            = now(),
    updated_at              = now()
  returning cc.id into v_id;

  return query select v_id, case when found then 'ATUALIZADO' else 'CRIADO' end, v_match.match_status;
end;
$function$;

-- Keep fiscal identity complete for every active/onboarding client.
create or replace function agency_ops.sync_client_fiscal_alert(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  v_client agency_ops.clients%rowtype;
  v_identity agency_ops.client_business_identity%rowtype;
  v_key text := 'FISCAL_IDENTITY:' || p_client_id::text;
  v_valid boolean := false;
begin
  select * into v_client from agency_ops.clients where id=p_client_id;
  if not found or v_client.lifecycle not in ('ACTIVE','ONBOARDING') then
    update agency_ops.operational_alerts
       set status='RESOLVED', resolved_at=now(), last_detected_at=now()
     where alert_key=v_key and status in ('OPEN','ACKNOWLEDGED');
    return;
  end if;

  select * into v_identity from agency_ops.client_business_identity where client_id=p_client_id;
  v_valid := found
    and (nullif(v_identity.cnpj,'') is not null or nullif(v_identity.cpf,'') is not null)
    and coalesce(v_identity.fiscal_document_validation,'')='VALID';

  if v_valid then
    update agency_ops.operational_alerts
       set status='RESOLVED', resolved_at=now(), last_detected_at=now(),
           metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
             'resolved_by','VALID_FISCAL_IDENTITY',
             'resolved_validation',v_identity.fiscal_document_validation
           )
     where alert_key=v_key and status in ('OPEN','ACKNOWLEDGED');
    return;
  end if;

  perform agency_ops.upsert_alert(
    v_key, p_client_id, 'CLIENT_FISCAL_IDENTITY_MISSING',
    case when v_client.lifecycle='ACTIVE' then 'HIGH' else 'MEDIUM' end,
    'CLIENT_FISCAL_IDENTITY',
    'CPF/CNPJ pendente · ' || v_client.display_name,
    'Cliente ativo/onboarding ainda não possui CPF ou CNPJ validado e consolidado na identidade fiscal.',
    'Localizar o contrato assinado ou outra fonte fiscal confiável, validar o documento e consolidar em client_business_identity.',
    jsonb_build_object(
      'client_name',v_client.display_name,
      'lifecycle',v_client.lifecycle,
      'entrada',v_client.entrada,
      'required_validation','VALID',
      'auto_resolve',true
    )
  );
end
$$;

create or replace function agency_ops.tg_sync_client_fiscal_alert()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
begin
  perform agency_ops.sync_client_fiscal_alert(coalesce(new.id,old.id));
  return coalesce(new,old);
end
$$;

create or replace function agency_ops.tg_sync_identity_fiscal_alert()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
begin
  perform agency_ops.sync_client_fiscal_alert(coalesce(new.client_id,old.client_id));
  return coalesce(new,old);
end
$$;

drop trigger if exists trg_clients_fiscal_identity_alert on agency_ops.clients;
create trigger trg_clients_fiscal_identity_alert
after insert or update of lifecycle,display_name
on agency_ops.clients
for each row execute function agency_ops.tg_sync_client_fiscal_alert();

drop trigger if exists trg_identity_fiscal_alert on agency_ops.client_business_identity;
create trigger trg_identity_fiscal_alert
after insert or update or delete
on agency_ops.client_business_identity
for each row execute function agency_ops.tg_sync_identity_fiscal_alert();

create or replace function agency_ops.refresh_fiscal_identity_alerts()
returns integer
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select id from agency_ops.clients
    where lifecycle in ('ACTIVE','ONBOARDING')
    union
    select client_id as id from agency_ops.operational_alerts
    where type='CLIENT_FISCAL_IDENTITY_MISSING' and client_id is not null
  loop
    perform agency_ops.sync_client_fiscal_alert(r.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- Recover missed Autentique webhook events by reconciling all documents hourly.
select cron.unschedule(jobid)
from cron.job
where jobname='autentique-full-reconcile';

select cron.schedule(
  'autentique-full-reconcile',
  '23 * * * *',
  $job$
  select net.http_post(
    'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-autentique-backfill',
    '{}'::jsonb,
    '{}'::jsonb,
    jsonb_build_object(
      'Content-Type','application/json',
      'x-ops-secret',(select value #>> '{}' from agency_ops.automation_settings where key='CONTRACT_ENRICH_SECRET')
    ),
    120000
  );
  $job$
);

select cron.unschedule(jobid)
from cron.job
where jobname='fiscal-identity-reconcile';

select cron.schedule(
  'fiscal-identity-reconcile',
  '31 * * * *',
  'select agency_ops.refresh_fiscal_identity_alerts();'
);

select agency_ops.refresh_fiscal_identity_alerts();
