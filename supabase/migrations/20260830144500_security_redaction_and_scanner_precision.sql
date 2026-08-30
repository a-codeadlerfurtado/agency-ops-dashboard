create or replace function agency_ops.redact_sensitive_text(p_value text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v text := coalesce(p_value,'');
begin
  v := regexp_replace(v, 'sk-[A-Za-z0-9_-]{20,}', '[CREDENCIAL OCULTADA]', 'g');
  v := regexp_replace(v, 'EAA[A-Za-z0-9]{30,}', '[CREDENCIAL OCULTADA]', 'g');
  v := regexp_replace(
    v,
    '(senha|password|token|api[ _-]?key|chave[[:space:]_-]*(de|da)?[[:space:]_-]*api|secret)[[:space:]]*[:=-]?[[:space:]]+[^[:space:],;]{4,300}',
    E'\\1: [CREDENCIAL OCULTADA]',
    'gi'
  );
  v := regexp_replace(
    v,
    '(login|usuario|usuário)[[:space:]]*[:=-]?[[:space:]]+[^[:space:],;]{3,200}',
    E'\\1: [ACESSO OCULTADO]',
    'gi'
  );
  v := regexp_replace(
    v,
    '([?&](access_token|token|api_key|key)=)[^&[:space:]]+',
    E'\\1[CREDENCIAL OCULTADA]',
    'gi'
  );
  return v;
end;
$$;

revoke all on function agency_ops.redact_sensitive_text(text) from public, anon, authenticated;
grant execute on function agency_ops.redact_sensitive_text(text) to service_role;

create or replace function agency_ops.cleanup_credential_exposure_false_positives()
returns integer
language plpgsql
security definer
set search_path = agency_ops, pg_temp
as $$
declare
  v_deleted integer := 0;
begin
  delete from agency_ops.credential_exposure_findings f
  using agency_ops.whatsapp_messages w
  where f.source_type='WHATSAPP'
    and f.source_id=w.id::text
    and f.secret_type='API_KEY'
    and (coalesce(w.text_body,'') || E'\n' || coalesce(w.caption,'')) !~* '(api[ _-]?key|chave[[:space:]_-]*(de|da)?[[:space:]_-]*api)';
  get diagnostics v_deleted = row_count;

  with deleted_notes as (
    delete from agency_ops.credential_exposure_findings f
    using agency_ops.ops_notes n
    where f.source_type='OPS_NOTE'
      and f.source_id=n.id::text
      and f.secret_type='API_KEY'
      and coalesce(n.body,'') !~* '(api[ _-]?key|chave[[:space:]_-]*(de|da)?[[:space:]_-]*api)'
    returning 1
  )
  select v_deleted + count(*) into v_deleted from deleted_notes;

  return v_deleted;
end;
$$;

revoke all on function agency_ops.cleanup_credential_exposure_false_positives() from public, anon, authenticated;
grant execute on function agency_ops.cleanup_credential_exposure_false_positives() to service_role;

create or replace function agency_ops.run_credential_security_scan()
returns jsonb
language plpgsql
security definer
set search_path = agency_ops, pg_temp
as $$
declare
  v_scan jsonb;
  v_removed integer;
begin
  v_scan := agency_ops.scan_credential_exposures();
  v_removed := agency_ops.cleanup_credential_exposure_false_positives();
  return v_scan || jsonb_build_object('false_positives_removed', v_removed);
end;
$$;

revoke all on function agency_ops.run_credential_security_scan() from public, anon, authenticated;
grant execute on function agency_ops.run_credential_security_scan() to service_role;

create or replace function agency_ops.build_client_waiting_digest()
returns jsonb
language plpgsql
stable
set search_path to 'agency_ops', 'pg_temp'
as $$
declare
  v_linhas text;
  v_n int;
begin
  select count(*), string_agg(l.linha, chr(10) || chr(10) order by l.minutos desc)
    into v_n, v_linhas
  from (
    select
      agency_ops.business_minutes(cs.waiting_since, now()) as minutos,
      '• *' || coalesce(c.display_name, cs.chat_id) || '* — ' ||
      case when agency_ops.business_minutes(cs.waiting_since, now()) < 60
           then agency_ops.business_minutes(cs.waiting_since, now()) || ' min'
           else round(agency_ops.business_minutes(cs.waiting_since, now()) / 60.0, 1) || 'h'
      end || ' de expediente sem resposta' ||
      chr(10) || '  GT: ' || coalesce(nullif(c.gt_owner,''), 'sem GT definido') ||
      coalesce(chr(10) || '  Assunto: ' ||
               left(regexp_replace(
                 agency_ops.redact_sensitive_text(coalesce(nullif(cs.open_question,''), cs.last_summary)),
                 '\\s+', ' ', 'g'
               ), 160), '') ||
      case when a.first_detected_at is not null
                and a.first_detected_at < now() - interval '7 days'
           then chr(10) || '  ⚠️ recorrente desde ' || to_char(a.first_detected_at,'DD/MM')
           else '' end as linha
    from agency_ops.conversation_state cs
    left join agency_ops.clients c on c.id = cs.client_id
    left join agency_ops.operational_alerts a
           on a.alert_key = 'WA_SLA:' || cs.chat_id and a.status = 'OPEN'
    where cs.waiting_for_agency
      and cs.sla_level in ('ATTENTION','CRITICAL')
      and cs.waiting_since is not null
      and agency_ops.business_minutes(cs.waiting_since, now()) >= 60
  ) l;

  if coalesce(v_n,0) = 0 then return jsonb_build_object('vazio', true); end if;

  return jsonb_build_object(
    'vazio', false,
    'clientes', v_n,
    'severity', 'CRITICAL',
    'message', '*Clientes aguardando resposta* (' || v_n || ')' || chr(10) ||
               '_Tempo contado em horário comercial._' || chr(10) || chr(10) || v_linhas
  );
end;
$$;

select cron.unschedule(jobid)
from cron.job
where jobname = 'agency-ops-credential-exposure-scan';

select cron.schedule(
  'agency-ops-credential-exposure-scan',
  '15 7 * * *',
  'select agency_ops.run_credential_security_scan();'
);

select agency_ops.cleanup_credential_exposure_false_positives();