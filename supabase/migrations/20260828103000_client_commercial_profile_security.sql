create table if not exists agency_ops.client_business_identity (
  client_id uuid primary key references agency_ops.clients(id) on delete cascade,
  legal_name text,
  cnpj text,
  cpf text,
  representative_name text,
  representative_cpf text,
  source_type text,
  source_id text,
  evidence_excerpt text,
  confidence numeric(5,4),
  verified_at timestamptz,
  verified_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agency_ops.client_private_commercial_terms (
  client_id uuid primary key references agency_ops.clients(id) on delete cascade,
  monthly_value numeric(12,2),
  implementation_value numeric(12,2),
  implementation_payment_terms text,
  implementation_due_timing text,
  first_monthly_due_terms text,
  minimum_ad_budget numeric(12,2),
  source_type text,
  source_id text,
  evidence_excerpt text,
  confidence numeric(5,4),
  verified_at timestamptz,
  verified_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_client_business_identity_cnpj
  on agency_ops.client_business_identity (cnpj) where cnpj is not null;
create index if not exists idx_client_business_identity_cpf
  on agency_ops.client_business_identity (cpf) where cpf is not null;

alter table agency_ops.client_business_identity enable row level security;
alter table agency_ops.client_private_commercial_terms enable row level security;

revoke all on table agency_ops.client_business_identity from anon, authenticated;
revoke all on table agency_ops.client_private_commercial_terms from anon, authenticated;
grant all on table agency_ops.client_business_identity to service_role;
grant all on table agency_ops.client_private_commercial_terms to service_role;

comment on table agency_ops.client_business_identity is
  'Identidade fiscal do cliente. A API publica CNPJ prioritariamente; CPF somente quando CNPJ nao existe.';
comment on table agency_ops.client_private_commercial_terms is
  'Termos comerciais privados. Mensalidade e implementacao so podem sair do backend para Adler Furtado e Leonardo Augusto.';
