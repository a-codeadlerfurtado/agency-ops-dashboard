create table if not exists agency_ops.external_crm_connections (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  provider text not null,
  display_name text,
  status text not null default 'PENDING_AUTH'
    check (status in ('PENDING_AUTH','READY','ACTIVE','ERROR','DISABLED','BLOCKED_PLAN')),
  auth_vault_item_id uuid references agency_ops.client_access_vault(id) on delete set null,
  webhook_token_hash text,
  webhook_token_hint text,
  config jsonb not null default '{}'::jsonb,
  last_event_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, provider)
);

create index if not exists external_crm_connections_client_idx
  on agency_ops.external_crm_connections (client_id, status);
create index if not exists external_crm_connections_provider_idx
  on agency_ops.external_crm_connections (provider, status);

create table if not exists agency_ops.external_crm_events (
  id bigint generated always as identity primary key,
  connection_id uuid not null references agency_ops.external_crm_connections(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  provider text not null,
  external_event_id text,
  external_lead_id text,
  event_type text not null,
  external_status text,
  canonical_stage text not null default 'UNKNOWN'
    check (canonical_stage in ('NEW','CONTACTED','QUALIFIED','VISIT_SCHEDULED','VISIT_COMPLETED','PROPOSAL','WON','LOST','UNKNOWN')),
  lead_name text,
  lead_email text,
  lead_phone text,
  product text,
  broker_name text,
  broker_email text,
  broker_phone text,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  source text not null default 'CRM_WEBHOOK',
  dedup_key text not null unique,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists external_crm_events_client_time_idx
  on agency_ops.external_crm_events (client_id, received_at desc);
create index if not exists external_crm_events_lead_idx
  on agency_ops.external_crm_events (client_id, provider, external_lead_id, received_at desc);
create index if not exists external_crm_events_stage_idx
  on agency_ops.external_crm_events (client_id, canonical_stage, received_at desc);

create or replace view agency_ops.external_crm_latest_lead_state as
select distinct on (client_id, provider, external_lead_id)
  id, connection_id, client_id, provider, external_lead_id, event_type,
  external_status, canonical_stage, lead_name, lead_email, lead_phone,
  product, broker_name, broker_email, broker_phone, occurred_at, received_at
from agency_ops.external_crm_events
where external_lead_id is not null
order by client_id, provider, external_lead_id, coalesce(occurred_at, received_at) desc, id desc;

create or replace view agency_ops.commercial_whatsapp_signal_candidates as
select
  m.id as whatsapp_message_id,
  r.client_id,
  r.chat_id,
  r.chat_name,
  m.event_at,
  coalesce(nullif(i.canonical_name,''), nullif(m.sender_name,''), nullif(m.sender_phone,''), 'Desconhecido') as sender_name,
  i.side as sender_side,
  i.role_hint,
  i.confidence as identity_confidence,
  coalesce(m.text_body,m.caption,'') as message_text,
  case
    when coalesce(m.text_body,m.caption,'') ~* '(venda[[:space:]]+(fechada|ganha)|vendemos|vendeu|vendido|fechamos|neg[oó]cio[[:space:]]+fechado)' then 'WON'
    when coalesce(m.text_body,m.caption,'') ~* '(proposta|fez[[:space:]]+uma[[:space:]]+oferta|enviou[[:space:]]+oferta)' then 'PROPOSAL'
    when coalesce(m.text_body,m.caption,'') ~* '(visita[[:space:]]+(realizada|feita|conclu[ií]da)|visitou[[:space:]]+o|fez[[:space:]]+a[[:space:]]+visita)' then 'VISIT_COMPLETED'
    when coalesce(m.text_body,m.caption,'') ~* '(visita.{0,30}(agendada|marcada)|agendei.{0,30}visita|marquei.{0,30}visita)' then 'VISIT_SCHEDULED'
    when coalesce(m.text_body,m.caption,'') ~* '(respondeu|consegui[[:space:]]+contato|entrei[[:space:]]+em[[:space:]]+contato|atendeu|falou[[:space:]]+com)' then 'CONTACTED'
    else 'UNKNOWN'
  end as candidate_stage,
  case
    when i.side = 'CLIENT' and coalesce(i.confidence,0) >= 0.8 then 0.85
    when i.side = 'CLIENT' then 0.70
    when coalesce(i.role_hint,'') ~* '(corretor|broker|vendas|comercial)' then 0.72
    else 0.50
  end::numeric as signal_confidence
from agency_ops.whatsapp_messages m
join agency_ops.whatsapp_chat_registry r on r.chat_id = m.chat_id
left join lateral (
  select p.canonical_name,p.side,p.role_hint,p.confidence
  from agency_ops.whatsapp_participant_identity p
  where p.chat_id = m.chat_id
    and (
      (p.phone is not null and p.phone in (m.participant_phone,m.sender_phone))
      or (p.sender_lid is not null and p.sender_lid in (m.participant_lid,m.sender_lid))
    )
  order by p.confidence desc nulls last, p.last_seen_at desc nulls last
  limit 1
) i on true
where r.chat_name ~* '^\\[COMERCIAL\\]'
  and coalesce(m.text_body,m.caption,'') ~* '(respondeu|contato|atendeu|visita|proposta|oferta|venda|vendido|fechamos|neg[oó]cio[[:space:]]+fechado)';

alter table agency_ops.external_crm_connections enable row level security;
alter table agency_ops.external_crm_events enable row level security;
revoke all on table agency_ops.external_crm_connections from anon, authenticated;
revoke all on table agency_ops.external_crm_events from anon, authenticated;
grant all on table agency_ops.external_crm_connections to service_role;
grant all on table agency_ops.external_crm_events to service_role;
grant select on agency_ops.external_crm_latest_lead_state to service_role;
grant select on agency_ops.commercial_whatsapp_signal_candidates to service_role;

comment on table agency_ops.external_crm_connections is
  'Canonical per-client external CRM connection registry. Secrets remain in client_access_vault or hashed.';
comment on table agency_ops.external_crm_events is
  'Normalized external CRM funnel events used for benchmark, attribution and reconciliation.';
comment on view agency_ops.commercial_whatsapp_signal_candidates is
  'Heuristic commercial WhatsApp signals. Candidates only: require reconciliation before becoming authoritative funnel events.';
