-- Campaign Builder: pedidos de criação de campanha por prompt (GT)
-- Cada linha é um pedido auditável: prompt do GT, plano estruturado gerado
-- pela IA, criativo anexado e IDs das entidades criadas na Meta (sempre pausadas).
begin;

create table if not exists agency_ops.campaign_build_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id),
  actor_user_id uuid not null,
  actor_person text not null,
  actor_role text not null,
  prompt text not null,
  status text not null default 'DRAFTED'
    check (status in ('DRAFTED','EXECUTING','CREATED','FAILED','DISCARDED')),
  plan jsonb,
  plan_hash text,
  plan_warnings jsonb not null default '[]'::jsonb,
  overrides jsonb,
  meta_ad_account_id text,
  meta_page_id text,
  creative_bucket text,
  creative_path text,
  creative_type text check (creative_type in ('IMAGE','VIDEO') or creative_type is null),
  creative_file_name text,
  created_campaign_id text,
  created_adset_id text,
  created_creative_id text,
  created_ad_id text,
  error text,
  request_metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_build_requests_client_idx
  on agency_ops.campaign_build_requests (client_id, created_at desc);
create index if not exists campaign_build_requests_actor_idx
  on agency_ops.campaign_build_requests (actor_user_id, created_at desc);

alter table agency_ops.campaign_build_requests enable row level security;
revoke all on agency_ops.campaign_build_requests from anon, authenticated;

create trigger campaign_build_requests_touch
  before update on agency_ops.campaign_build_requests
  for each row execute function public.touch_updated_at();

commit;
