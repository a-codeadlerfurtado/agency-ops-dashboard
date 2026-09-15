-- Central de Operacoes - AI Workspace
-- Persistencia privada de conversas, mensagens, anexos e uso.
-- Arquitetura final: frontend/backend na VPS Hostinger; Supabase como Auth/DB/Storage.
-- O frontend nunca acessa estas tabelas diretamente. O backend da Hostinger valida
-- o JWT do usuario no Supabase e somente entao usa credencial privada do servidor.

create table if not exists agency_ops.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person text,
  role text,
  access_level text not null default 'RESTRICTED',
  client_id uuid references agency_ops.clients(id) on delete set null,
  title text not null default 'Nova conversa',
  provider text not null default 'anthropic',
  model text,
  visibility text not null default 'PRIVATE' check (visibility in ('PRIVATE','TEAM')),
  is_archived boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index if not exists ai_conversations_user_recent_idx
  on agency_ops.ai_conversations (user_id, is_archived, last_message_at desc);
create index if not exists ai_conversations_client_idx
  on agency_ops.ai_conversations (client_id, last_message_at desc)
  where client_id is not null;

create table if not exists agency_ops.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references agency_ops.ai_conversations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  role text not null check (role in ('user','assistant','system','tool')),
  content text not null,
  provider text,
  model text,
  source text,
  request_id text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_messages_conversation_time_idx
  on agency_ops.ai_messages (conversation_id, created_at asc);
create unique index if not exists ai_messages_request_role_uidx
  on agency_ops.ai_messages (request_id, role)
  where request_id is not null;

create table if not exists agency_ops.ai_attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references agency_ops.ai_conversations(id) on delete cascade,
  message_id uuid references agency_ops.ai_messages(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  mime_type text,
  storage_path text not null,
  size_bytes bigint,
  status text not null default 'READY' check (status in ('UPLOADING','READY','ERROR','DELETED')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_attachments_conversation_idx
  on agency_ops.ai_attachments (conversation_id, created_at asc);

create table if not exists agency_ops.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references agency_ops.ai_conversations(id) on delete set null,
  message_id uuid references agency_ops.ai_messages(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  person text,
  provider text not null,
  model text,
  request_id text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  status text not null default 'SUCCESS',
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_user_time_idx
  on agency_ops.ai_usage_events (user_id, created_at desc);
create index if not exists ai_usage_conversation_idx
  on agency_ops.ai_usage_events (conversation_id, created_at desc);

alter table agency_ops.ai_conversations enable row level security;
alter table agency_ops.ai_messages enable row level security;
alter table agency_ops.ai_attachments enable row level security;
alter table agency_ops.ai_usage_events enable row level security;

-- Acesso direto pelo navegador permanece negado. O backend confiavel na Hostinger
-- usa a credencial privada do Supabase somente apos validar o JWT do colaborador.
revoke all on table agency_ops.ai_conversations from anon, authenticated;
revoke all on table agency_ops.ai_messages from anon, authenticated;
revoke all on table agency_ops.ai_attachments from anon, authenticated;
revoke all on table agency_ops.ai_usage_events from anon, authenticated;

grant select, insert, update, delete on table agency_ops.ai_conversations to service_role;
grant select, insert, update, delete on table agency_ops.ai_messages to service_role;
grant select, insert, update, delete on table agency_ops.ai_attachments to service_role;
grant select, insert, update, delete on table agency_ops.ai_usage_events to service_role;

comment on table agency_ops.ai_conversations is 'Conversas privadas da IA da Central de Operacoes por usuario autenticado.';
comment on table agency_ops.ai_messages is 'Mensagens persistidas das conversas da IA, incluindo metadados de modelo e uso.';
comment on table agency_ops.ai_attachments is 'Metadados de anexos da IA; bytes ficam em Storage privado.';
comment on table agency_ops.ai_usage_events is 'Auditoria e medicao de consumo da IA por usuario/conversa.';
