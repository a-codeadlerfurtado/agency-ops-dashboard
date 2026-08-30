create table if not exists agency_ops.credential_exposure_findings (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_id text not null,
  client_id uuid null references agency_ops.clients(id) on delete set null,
  source_at timestamptz null,
  source_title text null,
  secret_type text not null,
  severity text not null default 'HIGH',
  masked_context text not null,
  fingerprint text not null,
  status text not null default 'OPEN',
  detected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz null,
  resolution_note text null,
  resolved_by text null,
  constraint credential_exposure_findings_source_check check (source_type in ('WHATSAPP','OPS_NOTE')),
  constraint credential_exposure_findings_severity_check check (severity in ('HIGH','MEDIUM')),
  constraint credential_exposure_findings_status_check check (status in ('OPEN','ROTATED','IGNORED')),
  constraint credential_exposure_findings_unique unique (source_type, source_id, fingerprint)
);

create index if not exists idx_credential_exposure_findings_open
  on agency_ops.credential_exposure_findings (status, severity, detected_at desc);
create index if not exists idx_credential_exposure_findings_client
  on agency_ops.credential_exposure_findings (client_id, status, detected_at desc);

create table if not exists agency_ops.credential_exposure_scan_state (
  source_type text primary key,
  last_source_id bigint not null default 0,
  last_run_at timestamptz null,
  last_new_findings integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint credential_exposure_scan_state_source_check check (source_type in ('WHATSAPP','OPS_NOTE'))
);

insert into agency_ops.credential_exposure_scan_state(source_type)
values ('WHATSAPP'), ('OPS_NOTE')
on conflict (source_type) do nothing;

alter table agency_ops.credential_exposure_findings enable row level security;
alter table agency_ops.credential_exposure_scan_state enable row level security;
revoke all on agency_ops.credential_exposure_findings from public, anon, authenticated;
revoke all on agency_ops.credential_exposure_scan_state from public, anon, authenticated;
grant select, insert, update on agency_ops.credential_exposure_findings to service_role;
grant select, insert, update on agency_ops.credential_exposure_scan_state to service_role;

create or replace function agency_ops.scan_credential_exposures()
returns jsonb
language plpgsql
security definer
set search_path = agency_ops, extensions, pg_temp
as $$
declare
  whatsapp_last bigint := 0;
  note_last bigint := 0;
  whatsapp_max bigint := 0;
  note_max bigint := 0;
  whatsapp_changed integer := 0;
  note_changed integer := 0;
begin
  select last_source_id into whatsapp_last
  from agency_ops.credential_exposure_scan_state
  where source_type = 'WHATSAPP'
  for update;

  select last_source_id into note_last
  from agency_ops.credential_exposure_scan_state
  where source_type = 'OPS_NOTE'
  for update;

  select coalesce(max(id), whatsapp_last) into whatsapp_max
  from agency_ops.whatsapp_messages
  where id > whatsapp_last;

  with source_rows as (
    select
      w.id,
      w.chat_id,
      w.chat_name,
      w.event_at,
      coalesce(w.text_body, '') || E'\n' || coalesce(w.caption, '') as content,
      (
        select r.client_id
        from agency_ops.whatsapp_chat_registry r
        where r.chat_id = w.chat_id and r.client_id is not null
        order by case upper(coalesce(r.confidence,'')) when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end, r.updated_at desc
        limit 1
      ) as client_id
    from agency_ops.whatsapp_messages w
    where w.id > whatsapp_last
      and (
        coalesce(w.text_body,'') ilike any(array['%senha%','%password%','%token%','%api key%','%api_key%','%chave%','%secret%','%sk-%','%EAA%'])
        or coalesce(w.caption,'') ilike any(array['%senha%','%password%','%token%','%api key%','%api_key%','%chave%','%secret%','%sk-%','%EAA%'])
      )
  ), raw_matches as (
    select s.*, 'OPENAI_API_KEY'::text as secret_type, m[1] as secret, 'HIGH'::text as severity
    from source_rows s
    cross join lateral regexp_matches(s.content, '(sk-[A-Za-z0-9_-]{20,})', 'g') m
    union all
    select s.*, 'META_ACCESS_TOKEN', m[1], 'HIGH'
    from source_rows s
    cross join lateral regexp_matches(s.content, '(EAA[A-Za-z0-9]{30,})', 'g') m
    union all
    select s.*,
      case lower(m[1])
        when 'senha' then 'PASSWORD'
        when 'password' then 'PASSWORD'
        when 'token' then 'TOKEN'
        when 'secret' then 'SECRET'
        else 'API_KEY'
      end,
      m[2],
      'HIGH'
    from source_rows s
    cross join lateral regexp_matches(
      s.content,
      '(?i)(senha|password|token|api[ _-]?key|chave[ _-]?api|chave|secret)[[:space:]]*[:=-]?[[:space:]]+([^[:space:],;]{4,160})',
      'g'
    ) m
    where lower(m[2]) not in ('para','acesso','acessar','esta','esse','essa','voce','você','favor','api','aqui','depois','cliente','clientes','sistema','login')
      and m[2] !~ '^https?://'
      and m[2] !~ '^\[.*\]$'
  ), deduped as (
    select distinct on (id, secret)
      id, chat_id, chat_name, event_at, client_id, secret_type, secret, severity
    from raw_matches
    where length(secret) between 4 and 300
    order by id, secret,
      case secret_type when 'OPENAI_API_KEY' then 1 when 'META_ACCESS_TOKEN' then 2 when 'API_KEY' then 3 when 'TOKEN' then 4 else 5 end
  )
  insert into agency_ops.credential_exposure_findings (
    source_type, source_id, client_id, source_at, source_title,
    secret_type, severity, masked_context, fingerprint, status, last_seen_at
  )
  select
    'WHATSAPP', d.id::text, d.client_id, d.event_at, coalesce(nullif(d.chat_name,''),'WhatsApp'),
    d.secret_type, d.severity,
    case d.secret_type
      when 'OPENAI_API_KEY' then 'Chave da OpenAI exposta em texto; segredo ocultado.'
      when 'META_ACCESS_TOKEN' then 'Token da Meta exposto em texto; segredo ocultado.'
      when 'PASSWORD' then 'Senha exposta em texto; segredo ocultado.'
      when 'TOKEN' then 'Token exposto em texto; segredo ocultado.'
      else 'Credencial sensível exposta em texto; segredo ocultado.'
    end,
    encode(extensions.digest(convert_to(d.secret,'UTF8'),'sha256'),'hex'),
    'OPEN', now()
  from deduped d
  on conflict (source_type, source_id, fingerprint) do update
    set last_seen_at = excluded.last_seen_at,
        client_id = coalesce(agency_ops.credential_exposure_findings.client_id, excluded.client_id),
        source_title = excluded.source_title;
  get diagnostics whatsapp_changed = row_count;

  update agency_ops.credential_exposure_scan_state
  set last_source_id = whatsapp_max,
      last_run_at = now(),
      last_new_findings = whatsapp_changed,
      updated_at = now()
  where source_type = 'WHATSAPP';

  select coalesce(max(id), note_last) into note_max
  from agency_ops.ops_notes
  where id > note_last;

  with source_rows as (
    select id, client_id, occurred_at, author_name,
           coalesce(body,'') as content
    from agency_ops.ops_notes
    where id > note_last
      and coalesce(body,'') ilike any(array['%senha%','%password%','%token%','%api key%','%api_key%','%chave%','%secret%','%sk-%','%EAA%'])
  ), raw_matches as (
    select s.*, 'OPENAI_API_KEY'::text as secret_type, m[1] as secret, 'HIGH'::text as severity
    from source_rows s cross join lateral regexp_matches(s.content, '(sk-[A-Za-z0-9_-]{20,})', 'g') m
    union all
    select s.*, 'META_ACCESS_TOKEN', m[1], 'HIGH'
    from source_rows s cross join lateral regexp_matches(s.content, '(EAA[A-Za-z0-9]{30,})', 'g') m
    union all
    select s.*,
      case lower(m[1]) when 'senha' then 'PASSWORD' when 'password' then 'PASSWORD' when 'token' then 'TOKEN' when 'secret' then 'SECRET' else 'API_KEY' end,
      m[2], 'HIGH'
    from source_rows s
    cross join lateral regexp_matches(
      s.content,
      '(?i)(senha|password|token|api[ _-]?key|chave[ _-]?api|chave|secret)[[:space:]]*[:=-]?[[:space:]]+([^[:space:],;]{4,160})',
      'g'
    ) m
    where lower(m[2]) not in ('para','acesso','acessar','esta','esse','essa','voce','você','favor','api','aqui','depois','cliente','clientes','sistema','login')
      and m[2] !~ '^https?://'
      and m[2] !~ '^\[.*\]$'
  ), deduped as (
    select distinct on (id, secret)
      id, client_id, occurred_at, author_name, secret_type, secret, severity
    from raw_matches
    where length(secret) between 4 and 300
    order by id, secret,
      case secret_type when 'OPENAI_API_KEY' then 1 when 'META_ACCESS_TOKEN' then 2 when 'API_KEY' then 3 when 'TOKEN' then 4 else 5 end
  )
  insert into agency_ops.credential_exposure_findings (
    source_type, source_id, client_id, source_at, source_title,
    secret_type, severity, masked_context, fingerprint, status, last_seen_at
  )
  select
    'OPS_NOTE', d.id::text, d.client_id, d.occurred_at, coalesce(nullif(d.author_name,''),'Nota operacional'),
    d.secret_type, d.severity,
    case d.secret_type
      when 'OPENAI_API_KEY' then 'Chave da OpenAI exposta em nota; segredo ocultado.'
      when 'META_ACCESS_TOKEN' then 'Token da Meta exposto em nota; segredo ocultado.'
      when 'PASSWORD' then 'Senha exposta em nota; segredo ocultado.'
      when 'TOKEN' then 'Token exposto em nota; segredo ocultado.'
      else 'Credencial sensível exposta em nota; segredo ocultado.'
    end,
    encode(extensions.digest(convert_to(d.secret,'UTF8'),'sha256'),'hex'),
    'OPEN', now()
  from deduped d
  on conflict (source_type, source_id, fingerprint) do update
    set last_seen_at = excluded.last_seen_at,
        client_id = coalesce(agency_ops.credential_exposure_findings.client_id, excluded.client_id),
        source_title = excluded.source_title;
  get diagnostics note_changed = row_count;

  update agency_ops.credential_exposure_scan_state
  set last_source_id = note_max,
      last_run_at = now(),
      last_new_findings = note_changed,
      updated_at = now()
  where source_type = 'OPS_NOTE';

  return jsonb_build_object(
    'ok', true,
    'whatsapp_processed_until', whatsapp_max,
    'ops_notes_processed_until', note_max,
    'whatsapp_findings_touched', whatsapp_changed,
    'ops_note_findings_touched', note_changed,
    'open_findings', (select count(*) from agency_ops.credential_exposure_findings where status='OPEN')
  );
end;
$$;

revoke all on function agency_ops.scan_credential_exposures() from public, anon, authenticated;
grant execute on function agency_ops.scan_credential_exposures() to service_role;

alter function agency_ops.auto_promote_exact_pending_meta_review() set search_path = agency_ops, pg_temp;
alter function agency_ops.preserve_dashboard_upload_participants() set search_path = agency_ops, pg_temp;
alter function agency_ops.normalize_internal_workflow_label(text) set search_path = agency_ops, pg_temp;

revoke all on agency_ops.whatsapp_messages from anon, authenticated;
revoke all on agency_ops.ops_notes from anon, authenticated;
revoke all on agency_ops.security_audit_log from anon, authenticated;
revoke all on agency_ops.client_access_vault from anon, authenticated;
revoke all on agency_ops.client_access_vault_audit from anon, authenticated;

select cron.unschedule(jobid)
from cron.job
where jobname = 'agency-ops-credential-exposure-scan';

select cron.schedule(
  'agency-ops-credential-exposure-scan',
  '15 7 * * *',
  'select agency_ops.scan_credential_exposures();'
);