-- Registro de desligamentos. Nao havia onde marcar que alguem saiu: a pessoa sumia
-- do quadro mas seguia com historico no ClickUp, indistinguivel de um ativo sem cadastro.
create table if not exists agency_ops.team_former_members (
  id           uuid primary key default gen_random_uuid(),
  person       text not null,
  clickup_user text,
  left_at      date,
  reason       text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint team_former_members_person_uk unique (person)
);
alter table agency_ops.team_former_members enable row level security;
comment on table agency_ops.team_former_members is
  'Colaboradores desligados. Consumida por agency_ops.team_overview para marcar is_former.';
