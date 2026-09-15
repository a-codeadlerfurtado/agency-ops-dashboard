create table if not exists agency_ops.opsquestion_interactions (
  id uuid primary key default gen_random_uuid(),
  user_key text not null,
  person text,
  role text,
  access_level text,
  question text not null,
  answer text,
  status text not null default 'PENDING',
  source text not null default 'MAKE_AI',
  latency_ms integer,
  error text,
  request_id text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists opsquestion_interactions_user_created_idx
  on agency_ops.opsquestion_interactions(user_key, created_at desc);
create index if not exists opsquestion_interactions_status_created_idx
  on agency_ops.opsquestion_interactions(status, created_at desc);

alter table agency_ops.opsquestion_interactions enable row level security;
revoke all on agency_ops.opsquestion_interactions from anon, authenticated;
comment on table agency_ops.opsquestion_interactions is 'Audit log do OpsQuestion. Perguntas e respostas da IA operacional; escrita somente server-side.';
