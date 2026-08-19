-- Registro unico de identidade por colaborador. Cada sistema tinha sua propria chave e o
-- cruzamento era por nome, com lower()/prefixo - fragil ("joel antoniete",
-- "Davi Henrique Florencio de Andrade", "Gustavo" vs "Gustavo Lima").
create table if not exists agency_ops.team_identities (
  id            uuid primary key default gen_random_uuid(),
  person        text not null,
  system        text not null check (system in
                  ('EMAIL','CLICKUP','WHATSAPP_PHONE','WHATSAPP_NAME','SUPABASE_AUTH','META','NOTION','GOOGLE')),
  external_id   text not null,
  external_name text,
  verified      boolean not null default false,
  matched_by    text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint team_identities_system_external_uk unique (system, external_id),
  constraint team_identities_person_system_uk   unique (person, system, external_id)
);
alter table agency_ops.team_identities enable row level security;
create index if not exists team_identities_person_idx on agency_ops.team_identities (person);
comment on table agency_ops.team_identities is
  'Identidade do colaborador em cada sistema externo. Fonte canonica para cruzar ClickUp, WhatsApp, Auth e Meta sem depender de nome.';

create table if not exists agency_ops.team_name_aliases (
  alias      text primary key,
  person     text not null,
  source     text,
  created_at timestamptz not null default now()
);
insert into agency_ops.team_name_aliases (alias, person, source) values
  ('gustavo','Gustavo Lima','whatsapp'),
  ('nycollas','Davi Nycollas','whatsapp'),
  ('davi','Davi Henrique','whatsapp'),
  ('hugo','Vitor Hugo','whatsapp'),
  ('joel','Joel Antoniete','whatsapp'),
  ('joel cs','Joel Antoniete','whatsapp')
on conflict (alias) do nothing;
