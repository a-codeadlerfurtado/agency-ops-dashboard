-- Fundacao da cobranca recorrente via Asaas.
-- Espelha customers, assinaturas e cobrancas; a inadimplencia passa a ser
-- derivada de agency_ops.billing_charges em vez de marcada a mao.
-- Spec: docs/superpowers/specs/2026-09-04-cobranca-recorrente-asaas-design.md

-- 1. O elo cliente <-> customer do Asaas.
create table if not exists agency_ops.asaas_customers (
  client_id         uuid primary key references agency_ops.clients(id) on delete cascade,
  asaas_customer_id text not null unique,
  matched_by        text not null check (matched_by in ('DOCUMENT','MANUAL')),
  matched_document  text,
  confirmed_by      text,
  confirmed_at      timestamptz,
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table agency_ops.asaas_customers is
  'Elo entre cliente e customer do Asaas. confirmed_at nulo = candidato, nunca usado para emitir.';

-- 2. Espelho das assinaturas. due_day so existe aqui: nao ha dia de vencimento
--    em nenhuma outra tabela do schema.
create table if not exists agency_ops.billing_subscriptions (
  asaas_subscription_id text primary key,
  client_id             uuid references agency_ops.clients(id) on delete set null,
  value                 numeric(12,2) not null,
  due_day               int not null check (due_day between 1 and 31),
  cycle                 text not null,
  status                text not null,
  billing_type          text,
  next_due_date         date,
  raw                   jsonb,
  synced_at             timestamptz not null default now()
);

create index if not exists billing_subscriptions_client_idx
  on agency_ops.billing_subscriptions (client_id);

-- 3. A cobranca. Fonte da verdade de todo indicador financeiro.
create table if not exists agency_ops.billing_charges (
  asaas_payment_id      text primary key,
  client_id             uuid references agency_ops.clients(id) on delete set null,
  -- Elo direto com o customer do Asaas. client_id nasce nulo enquanto a Fase 2
  -- nao confirma o elo, e volta a nulo se o cliente for apagado; sem esta
  -- coluna a cobranca ficaria orfa, so alcancavel por raw->>'customer'.
  asaas_customer_id     text,
  asaas_subscription_id text,
  kind                  text not null check (kind in ('MENSALIDADE','IMPLANTACAO','EXTRA')),
  value                 numeric(12,2) not null,
  net_value             numeric(12,2),
  due_date              date not null,
  status                text not null,
  billing_type          text,
  payment_date          date,
  -- Capacidade futura da visao "tempo medio entre vencimento e pagamento"
  -- (spec 6). O mapper nao escreve aqui: payment_date date continua sendo o
  -- campo gravado pelo webhook.
  paid_at               timestamptz,
  invoice_url           text,
  bank_slip_url         text,
  description           text,
  raw                   jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists billing_charges_client_due_idx
  on agency_ops.billing_charges (client_id, due_date desc);
create index if not exists billing_charges_status_due_idx
  on agency_ops.billing_charges (status, due_date);
create index if not exists billing_charges_subscription_idx
  on agency_ops.billing_charges (asaas_subscription_id);
create index if not exists billing_charges_asaas_customer_idx
  on agency_ops.billing_charges (asaas_customer_id);

-- 4. Idempotencia do webhook. A unicidade de asaas_event_id e o que impede
--    que reprocessar a fila conte um pagamento duas vezes.
create table if not exists agency_ops.billing_webhook_events (
  id             bigserial primary key,
  asaas_event_id text not null unique,
  event          text not null,
  payment_id     text,
  payload        jsonb not null,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,
  error          text
);

create index if not exists billing_webhook_events_pendentes_idx
  on agency_ops.billing_webhook_events (received_at)
  where processed_at is null;

-- 5. RLS ligada e SEM policy: leitura exclusiva do service_role, ou seja, so
--    pelas edge functions. A chave anon nao alcanca dado financeiro.
alter table agency_ops.asaas_customers        enable row level security;
alter table agency_ops.billing_subscriptions  enable row level security;
alter table agency_ops.billing_charges        enable row level security;
alter table agency_ops.billing_webhook_events enable row level security;

revoke all on agency_ops.asaas_customers        from anon, authenticated;
revoke all on agency_ops.billing_subscriptions  from anon, authenticated;
revoke all on agency_ops.billing_charges        from anon, authenticated;
revoke all on agency_ops.billing_webhook_events from anon, authenticated;

grant select, insert, update, delete on agency_ops.asaas_customers        to service_role;
grant select, insert, update, delete on agency_ops.billing_subscriptions  to service_role;
grant select, insert, update, delete on agency_ops.billing_charges        to service_role;
grant select, insert, update, delete on agency_ops.billing_webhook_events to service_role;
grant usage, select on sequence agency_ops.billing_webhook_events_id_seq  to service_role;

-- 6. client_finance_controls ja existe com CHECK em payment_status aceitando
--    UNKNOWN, CURRENT, DUE_SOON, OVERDUE, NEGOTIATING, PAID e CANCELLED.
--    Falta separar atraso curto (OVERDUE, D+1 a D+4) de inadimplencia
--    (DELINQUENT, D+5 ou mais). A tabela esta vazia, entao nenhuma linha
--    existente viola a constraint nova.
alter table agency_ops.client_finance_controls
  drop constraint if exists client_finance_controls_payment_status_check;

alter table agency_ops.client_finance_controls
  add constraint client_finance_controls_payment_status_check
  check (payment_status in (
    'UNKNOWN','CURRENT','DUE_SOON','OVERDUE','DELINQUENT','NEGOTIATING','PAID','CANCELLED'
  ));
