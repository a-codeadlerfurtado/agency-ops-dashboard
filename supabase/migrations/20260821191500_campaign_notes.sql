create table if not exists agency_ops.campaign_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  campaign_id text not null,
  campaign_name text,
  account_key text,
  note text not null check (length(trim(note)) between 1 and 4000),
  author_user_key text not null,
  author_person text not null,
  created_at timestamptz not null default now()
);

create index if not exists campaign_notes_client_campaign_idx
  on agency_ops.campaign_notes (client_id, campaign_id, created_at desc);

create index if not exists campaign_notes_author_idx
  on agency_ops.campaign_notes (author_person, created_at desc);

alter table agency_ops.campaign_notes enable row level security;
revoke all on agency_ops.campaign_notes from anon, authenticated;
grant all on agency_ops.campaign_notes to service_role;

comment on table agency_ops.campaign_notes is
  'Observacoes manuais dos gestores de trafego sobre campanhas Meta. Escrita e leitura passam pela API autenticada, com escopo de carteira validado no servidor.';
