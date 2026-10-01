create table if not exists agency_ops.relato_operational_call_records (
  id uuid primary key default gen_random_uuid(),
  capture_session_id uuid not null unique references agency_ops.meeting_capture_sessions(id) on delete cascade,
  transcript_id bigint,
  owner_person text not null,
  owner_role text not null,
  client_id uuid,
  client_name text,
  channel text,
  summary text,
  health text,
  churn_risk boolean not null default false,
  operational jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint relato_operational_call_records_role_chk check (owner_role in ('CS','GT'))
);

create index if not exists idx_relato_operational_calls_owner
  on agency_ops.relato_operational_call_records(owner_person, submitted_at desc);

create index if not exists idx_relato_operational_calls_client
  on agency_ops.relato_operational_call_records(client_id, submitted_at desc);

create index if not exists idx_relato_operational_calls_role
  on agency_ops.relato_operational_call_records(owner_role, submitted_at desc);
