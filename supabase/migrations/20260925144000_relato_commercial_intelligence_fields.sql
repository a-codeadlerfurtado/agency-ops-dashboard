alter table agency_ops.commercial_call_records
  add column if not exists primary_pain text,
  add column if not exists secondary_pains text[] not null default '{}'::text[],
  add column if not exists goals text[] not null default '{}'::text[],
  add column if not exists urgency text,
  add column if not exists decision_role text,
  add column if not exists current_structure text,
  add column if not exists services_interest text[] not null default '{}'::text[],
  add column if not exists buying_signals text[] not null default '{}'::text[],
  add column if not exists closing_risks text[] not null default '{}'::text[],
  add column if not exists closer_briefing text;

alter table agency_ops.commercial_prospect_profiles
  add column if not exists primary_pain text,
  add column if not exists secondary_pains text[] not null default '{}'::text[],
  add column if not exists buying_signals text[] not null default '{}'::text[],
  add column if not exists closing_risks text[] not null default '{}'::text[];

alter table crm.lead_activities
  add column if not exists external_id text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists lead_activities_external_id_uidx
  on crm.lead_activities(external_id)
  where external_id is not null;
