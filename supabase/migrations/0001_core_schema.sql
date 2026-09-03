-- Imobi-Board 0001 - schema base (spec PASSO 4)
-- Isolado em schema proprio dentro do projeto imobi-pro: nao toca public.
--   imobi_board      -> exposto ao PostgREST
--   imobi_board_priv -> helpers SECURITY DEFINER, nunca exposto

create schema if not exists imobi_board;
create schema if not exists imobi_board_priv;

revoke all on schema imobi_board_priv from public;
grant usage on schema imobi_board to authenticated;

-- ---------------------------------------------------------------- enums
-- enums em vez de text+check: 4 bytes por linha e comparacao por inteiro.
create type imobi_board.tenant_status as enum ('ACTIVE', 'INACTIVE');
create type imobi_board.member_role   as enum ('ADMIN', 'BROKER');
create type imobi_board.member_status as enum ('ACTIVE', 'INACTIVE');
create type imobi_board.opp_status    as enum ('OPEN', 'WON', 'LOST');
create type imobi_board.stage_kind    as enum ('NEW', 'CONTACTED', 'QUALIFIED', 'VISIT', 'PROPOSAL', 'WON', 'LOST');
create type imobi_board.activity_type as enum ('NOTE', 'CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'STATUS_CHANGE', 'VISIT', 'PROPOSAL', 'SYSTEM');
create type imobi_board.task_status   as enum ('OPEN', 'DONE', 'CANCELLED');

-- ------------------------------------------------------- updated_at util
create or replace function imobi_board_priv.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

-- ------------------------------------------------------------- tenants
create table imobi_board.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 120),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  status     imobi_board.tenant_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tenants_touch before update on imobi_board.tenants
  for each row execute function imobi_board_priv.touch_updated_at();

-- ------------------------------------------------------------ profiles
create table imobi_board.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  phone      text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on imobi_board.profiles
  for each row execute function imobi_board_priv.touch_updated_at();

-- --------------------------------------------------------- memberships
create table imobi_board.memberships (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references imobi_board.tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       imobi_board.member_role   not null,
  status     imobi_board.member_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
-- lookup quente: toda policy de RLS passa por aqui.
create index memberships_user_active_idx
  on imobi_board.memberships (user_id, tenant_id, role)
  where status = 'ACTIVE';
create index memberships_tenant_idx on imobi_board.memberships (tenant_id);
create trigger memberships_touch before update on imobi_board.memberships
  for each row execute function imobi_board_priv.touch_updated_at();

-- ------------------------------------------------------------ contacts
-- Pessoa. Identidade por tenant (spec 15): sem constraint global de telefone.
create table imobi_board.contacts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references imobi_board.tenants(id) on delete cascade,
  full_name        text not null check (length(btrim(full_name)) between 1 and 160),
  phone            text,
  phone_normalized text,
  email            text,
  email_normalized text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
-- dedupe (spec 17) garantido no banco, nao apenas na aplicacao.
create unique index contacts_tenant_phone_uq
  on imobi_board.contacts (tenant_id, phone_normalized)
  where phone_normalized is not null;
create unique index contacts_tenant_email_uq
  on imobi_board.contacts (tenant_id, email_normalized)
  where email_normalized is not null;
create index contacts_tenant_name_idx
  on imobi_board.contacts (tenant_id, full_name);
create trigger contacts_touch before update on imobi_board.contacts
  for each row execute function imobi_board_priv.touch_updated_at();

-- ----------------------------------------------------------- pipelines
create table imobi_board.pipelines (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references imobi_board.tenants(id) on delete cascade,
  name       text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pipelines_one_default_uq
  on imobi_board.pipelines (tenant_id) where is_default;
create index pipelines_tenant_idx on imobi_board.pipelines (tenant_id);
create trigger pipelines_touch before update on imobi_board.pipelines
  for each row execute function imobi_board_priv.touch_updated_at();

-- 'kind' preserva a semantica quando o ADMIN renomeia o estagio (spec 18):
-- funil e analytics leem kind; a UI mostra name.
create table imobi_board.pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references imobi_board.tenants(id) on delete cascade,
  pipeline_id uuid not null references imobi_board.pipelines(id) on delete cascade,
  name        text not null,
  kind        imobi_board.stage_kind not null,
  sort_order  smallint not null check (sort_order >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint pipeline_stages_position_uq unique (pipeline_id, sort_order) deferrable initially deferred
);
create index pipeline_stages_pipeline_idx
  on imobi_board.pipeline_stages (pipeline_id, sort_order);
create trigger pipeline_stages_touch before update on imobi_board.pipeline_stages
  for each row execute function imobi_board_priv.touch_updated_at();

-- ------------------------------------------------------- opportunities
create table imobi_board.opportunities (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references imobi_board.tenants(id) on delete cascade,
  contact_id       uuid not null references imobi_board.contacts(id) on delete restrict,

  assigned_user_id uuid references auth.users(id) on delete set null,

  pipeline_id      uuid not null references imobi_board.pipelines(id) on delete restrict,
  stage_id         uuid not null references imobi_board.pipeline_stages(id) on delete restrict,

  -- FKs adicionadas na 0004, quando properties/developments existirem.
  property_id      uuid,
  development_id   uuid,

  status           imobi_board.opp_status not null default 'OPEN',

  -- atribuicao de midia (spec 53/54): guardada desde o dia 1.
  source           text not null default 'MANUAL',
  source_detail    text,
  campaign_id      text,
  campaign_name    text,
  adset_id         text,
  adset_name       text,
  ad_id            text,
  ad_name          text,
  form_id          text,
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  utm_content      text,
  utm_term         text,

  -- idempotencia de webhook (spec 64)
  external_source_id text,
  external_event_id  text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  first_assigned_at timestamptz,
  accepted_at       timestamptz,
  first_contact_at  timestamptz,
  qualified_at      timestamptz,
  closed_at         timestamptz,

  -- denormalizado de proposito: 23 vira index range scan, sem join em activities.
  last_interaction_at timestamptz not null default now(),

  lost_reason      text,

  constraint opportunities_lost_reason_ck
    check (status <> 'LOST' or lost_reason is not null)
);

-- webhook repetido nao vira oportunidade nova (spec 64)
create unique index opportunities_external_event_uq
  on imobi_board.opportunities (tenant_id, source, external_event_id)
  where external_event_id is not null;

-- Kanban e lista do ADMIN: filtra tenant, agrupa por estagio, ordena por entrada.
create index opportunities_tenant_stage_idx
  on imobi_board.opportunities (tenant_id, stage_id, created_at desc);
-- "Meus leads" do corretor: a query mais chamada do produto.
create index opportunities_assigned_idx
  on imobi_board.opportunities (assigned_user_id, status, created_at desc)
  where assigned_user_id is not null;
-- 23 leads esquecidos: so oportunidades abertas entram na varredura.
create index opportunities_stale_idx
  on imobi_board.opportunities (tenant_id, last_interaction_at)
  where status = 'OPEN';
create index opportunities_contact_idx
  on imobi_board.opportunities (contact_id);
-- atribuicao por campanha (spec 46): parcial, a maioria dos leads nao tem campanha.
create index opportunities_campaign_idx
  on imobi_board.opportunities (tenant_id, campaign_id)
  where campaign_id is not null;

create trigger opportunities_touch before update on imobi_board.opportunities
  for each row execute function imobi_board_priv.touch_updated_at();

-- ---------------------------------------------------------- activities
-- Absorve o historico de estagio (spec 19) via type=STATUS_CHANGE +
-- from_stage_id/to_stage_id, em vez de uma tabela dedicada: uma tabela a menos,
-- um indice a menos, mesma informacao.
create table imobi_board.activities (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references imobi_board.tenants(id) on delete cascade,
  opportunity_id uuid not null references imobi_board.opportunities(id) on delete cascade,
  type           imobi_board.activity_type not null,
  body           text,
  from_stage_id  uuid references imobi_board.pipeline_stages(id) on delete set null,
  to_stage_id    uuid references imobi_board.pipeline_stages(id) on delete set null,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint activities_stage_change_ck
    check (type <> 'STATUS_CHANGE' or to_stage_id is not null)
);
create index activities_opportunity_idx
  on imobi_board.activities (opportunity_id, created_at desc);

-- --------------------------------------------------------------- tasks
create table imobi_board.tasks (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references imobi_board.tenants(id) on delete cascade,
  opportunity_id   uuid references imobi_board.opportunities(id) on delete cascade,
  assigned_user_id uuid not null references auth.users(id) on delete cascade,
  title            text not null check (length(btrim(title)) between 1 and 200),
  description      text,
  due_at           timestamptz not null,
  completed_at     timestamptz,
  status           imobi_board.task_status not null default 'OPEN',
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tasks_done_ck check (status <> 'DONE' or completed_at is not null)
);
-- "hoje / atrasados / futuros" do dashboard do corretor (spec 22) em um indice so.
create index tasks_agenda_idx
  on imobi_board.tasks (assigned_user_id, due_at)
  where status = 'OPEN';
create index tasks_opportunity_idx
  on imobi_board.tasks (opportunity_id) where opportunity_id is not null;
create trigger tasks_touch before update on imobi_board.tasks
  for each row execute function imobi_board_priv.touch_updated_at();

-- ------------------------------------------------------- domain_events
-- Outbox simples (spec 35). Nao e event sourcing: a verdade esta nas tabelas.
create table imobi_board.domain_events (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null references imobi_board.tenants(id) on delete cascade,
  event_type     text not null,
  aggregate_type text not null,
  aggregate_id   uuid not null,
  payload        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  processed_at   timestamptz
);
-- indice so sobre o que falta processar: fica minusculo mesmo com milhoes de eventos.
create index domain_events_unprocessed_idx
  on imobi_board.domain_events (id) where processed_at is null;
create index domain_events_aggregate_idx
  on imobi_board.domain_events (aggregate_type, aggregate_id, created_at desc);

-- ---------------------------------------------------------- audit_logs
create table imobi_board.audit_logs (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references imobi_board.tenants(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  created_at    timestamptz not null default now()
);
create index audit_logs_tenant_idx
  on imobi_board.audit_logs (tenant_id, created_at desc);
