begin;

create table if not exists agency_ops.safe_action_requests (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  actor_person text not null,
  actor_role text not null,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  action_type text not null check (action_type in ('META_PAUSE_CAMPAIGNS','META_RESUME_CAMPAIGNS')),
  target_ids jsonb not null default '[]'::jsonb,
  preview_state jsonb not null default '[]'::jsonb,
  preview_hash text not null,
  preview_created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'PREVIEWED' check (status in ('PREVIEWED','EXECUTING','VERIFIED','FAILED','ROLLED_BACK','EXPIRED')),
  confirmed_at timestamptz,
  executed_at timestamptz,
  before_state jsonb,
  after_state jsonb,
  verification jsonb,
  error text,
  request_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists safe_action_requests_actor_idx on agency_ops.safe_action_requests(actor_user_id, created_at desc);
create index if not exists safe_action_requests_client_idx on agency_ops.safe_action_requests(client_id, created_at desc);
create index if not exists safe_action_requests_status_idx on agency_ops.safe_action_requests(status, expires_at);

alter table agency_ops.safe_action_requests enable row level security;
revoke all on agency_ops.safe_action_requests from anon, authenticated;

drop trigger if exists safe_action_requests_touch_updated_at on agency_ops.safe_action_requests;
create trigger safe_action_requests_touch_updated_at
before update on agency_ops.safe_action_requests
for each row execute function public.touch_updated_at();

commit;
