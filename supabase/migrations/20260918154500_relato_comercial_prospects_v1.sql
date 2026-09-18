alter table agency_ops.team_roster drop constraint if exists team_roster_role_check;
alter table agency_ops.team_roster
  add constraint team_roster_role_check
  check (role = any (array[
    'GT'::text,'CS'::text,'DESIGN'::text,'AI'::text,'MGMT'::text,
    'COMMERCIAL'::text,'CLOSER'::text,'SDR'::text
  ]));

create table if not exists agency_ops.commercial_prospect_profiles (
  lead_id uuid primary key references crm.leads(id) on delete cascade,
  city text,
  region text,
  website text,
  decision_role text,
  broker_count integer check (broker_count is null or broker_count >= 0),
  current_structure text,
  marketing_investment text,
  pain_points text[] not null default '{}',
  goals text[] not null default '{}',
  services_interest text[] not null default '{}',
  objections text[] not null default '{}',
  urgency text,
  qualification_summary text,
  closer_briefing text,
  next_step text,
  next_step_at timestamptz,
  sdr_person text,
  closer_person text not null default 'Vitor Feitoza',
  last_call_at timestamptz,
  last_transcript_id bigint references agency_ops.meeting_transcripts(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agency_ops.commercial_call_records (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references crm.leads(id) on delete cascade,
  capture_session_id uuid references agency_ops.meeting_capture_sessions(id) on delete set null,
  transcript_id bigint references agency_ops.meeting_transcripts(id) on delete set null,
  sdr_person text,
  closer_person text not null default 'Vitor Feitoza',
  channel text not null default 'WHATSAPP_DESKTOP',
  remote_phone text,
  remote_name text,
  outcome text,
  notes text,
  ai_summary text,
  pain_points text[] not null default '{}',
  objections text[] not null default '{}',
  next_step text,
  next_step_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists commercial_call_records_capture_session_uidx
  on agency_ops.commercial_call_records(capture_session_id)
  where capture_session_id is not null;
create index if not exists commercial_call_records_lead_created_idx
  on agency_ops.commercial_call_records(lead_id, created_at desc);
create index if not exists commercial_call_records_transcript_idx
  on agency_ops.commercial_call_records(transcript_id)
  where transcript_id is not null;
create table if not exists agency_ops.commercial_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references crm.leads(id) on delete cascade,
  activity_type text not null,
  title text not null,
  description text,
  owner_person text,
  due_at timestamptz,
  completed_at timestamptz,
  source text not null default 'DASH_OPS',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commercial_activities_lead_idx
  on agency_ops.commercial_activities(lead_id, created_at desc);
create index if not exists commercial_activities_due_idx
  on agency_ops.commercial_activities(owner_person, due_at)
  where completed_at is null and due_at is not null;

alter table agency_ops.commercial_prospect_profiles enable row level security;
alter table agency_ops.commercial_call_records enable row level security;
alter table agency_ops.commercial_activities enable row level security;
