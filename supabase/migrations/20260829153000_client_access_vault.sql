-- Client access vault
-- Secrets are never readable through anon/authenticated PostgREST roles.
-- Only service-role Edge Functions may read ciphertext.

create table if not exists agency_ops.client_access_vault (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  category text not null default 'CRM' check (category in ('CRM','SITE','GOOGLE_BUSINESS','PORTAL','OTHER')),
  system_name text not null,
  login_url text,
  login_ciphertext text,
  login_iv text,
  password_ciphertext text not null,
  password_iv text not null,
  notes_ciphertext text,
  notes_iv text,
  encryption_version smallint not null default 1,
  created_by_user_id uuid,
  created_by_person text,
  created_at timestamptz not null default now(),
  updated_by_user_id uuid,
  updated_by_person text,
  updated_at timestamptz not null default now(),
  constraint client_access_vault_login_pair check (
    (login_ciphertext is null and login_iv is null)
    or (login_ciphertext is not null and login_iv is not null)
  ),
  constraint client_access_vault_notes_pair check (
    (notes_ciphertext is null and notes_iv is null)
    or (notes_ciphertext is not null and notes_iv is not null)
  )
);

create index if not exists client_access_vault_client_idx
  on agency_ops.client_access_vault (client_id, category, system_name);

create table if not exists agency_ops.client_access_vault_audit (
  id bigint generated always as identity primary key,
  client_id uuid not null,
  vault_item_id uuid,
  actor_user_id uuid not null,
  actor_person text not null,
  actor_role text not null,
  action text not null check (action in (
    'LIST','REVEAL','COPY_LOGIN','COPY_PASSWORD','CREATE','UPDATE','DELETE',
    'REAUTH_FAILED','REAUTH_LOCKED','ACCESS_DENIED'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists client_access_vault_audit_actor_idx
  on agency_ops.client_access_vault_audit (actor_user_id, created_at desc);
create index if not exists client_access_vault_audit_client_idx
  on agency_ops.client_access_vault_audit (client_id, created_at desc);

alter table agency_ops.client_access_vault enable row level security;
alter table agency_ops.client_access_vault_audit enable row level security;

-- Explicitly remove browser/database-role access. The service role bypasses RLS
-- and is held only by the Edge Function runtime.
revoke all on table agency_ops.client_access_vault from anon, authenticated;
revoke all on table agency_ops.client_access_vault_audit from anon, authenticated;
grant all on table agency_ops.client_access_vault to service_role;
grant all on table agency_ops.client_access_vault_audit to service_role;

grant usage, select on sequence agency_ops.client_access_vault_audit_id_seq to service_role;

comment on table agency_ops.client_access_vault is
  'Encrypted client system credentials. Ciphertext only; direct anon/authenticated access is revoked.';
comment on table agency_ops.client_access_vault_audit is
  'Non-secret audit trail for access, reveal, copy, mutation and denied attempts.';
