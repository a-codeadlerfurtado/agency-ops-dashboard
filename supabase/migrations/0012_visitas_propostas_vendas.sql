-- Imobi-Board 0012 - visitas, propostas e vendas
-- (spec PASSOS 17/18/19, secoes 43-46)

create type imobi_board.visit_status    as enum ('SCHEDULED','COMPLETED','CANCELLED','NO_SHOW');
create type imobi_board.proposal_status as enum ('DRAFT','SENT','NEGOTIATING','ACCEPTED','REJECTED','CANCELLED');

create table imobi_board.visits (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references imobi_board.tenants(id) on delete cascade,
  opportunity_id uuid not null references imobi_board.opportunities(id) on delete cascade,
  contact_id     uuid not null references imobi_board.contacts(id) on delete restrict,
  property_id    uuid references imobi_board.properties(id) on delete set null,
  broker_id      uuid not null references auth.users(id) on delete restrict,
  scheduled_at   timestamptz not null,
  status         imobi_board.visit_status not null default 'SCHEDULED',
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index visits_agenda_idx on imobi_board.visits (broker_id, scheduled_at)
  where status = 'SCHEDULED';
create index visits_tenant_idx on imobi_board.visits (tenant_id, scheduled_at desc);
create index visits_opportunity_idx on imobi_board.visits (opportunity_id);
create trigger visits_touch before update on imobi_board.visits
  for each row execute function imobi_board_priv.touch_updated_at();

create table imobi_board.proposals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references imobi_board.tenants(id) on delete cascade,
  opportunity_id   uuid not null references imobi_board.opportunities(id) on delete cascade,
  contact_id       uuid not null references imobi_board.contacts(id) on delete restrict,
  property_id      uuid references imobi_board.properties(id) on delete set null,
  broker_id        uuid not null references auth.users(id) on delete restrict,
  list_price       numeric(14,2),
  offered_price    numeric(14,2) not null check (offered_price > 0),
  down_payment     numeric(14,2),
  financing_amount numeric(14,2),
  valid_until      date,
  notes            text,
  status           imobi_board.proposal_status not null default 'DRAFT',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index proposals_tenant_idx on imobi_board.proposals (tenant_id, created_at desc);
create index proposals_opportunity_idx on imobi_board.proposals (opportunity_id);
create index proposals_broker_idx on imobi_board.proposals (broker_id, status);
create trigger proposals_touch before update on imobi_board.proposals
  for each row execute function imobi_board_priv.touch_updated_at();

-- Venda com snapshot de atribuicao (spec 45). Os campos de campanha sao COPIA,
-- nao referencia: se a campanha for renomeada ou apagada na Meta seis meses
-- depois, a venda continua sabendo de onde veio. E o que sustenta a secao 54.
create table imobi_board.sales (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references imobi_board.tenants(id) on delete cascade,
  opportunity_id uuid not null unique references imobi_board.opportunities(id) on delete restrict,
  proposal_id    uuid references imobi_board.proposals(id) on delete set null,
  contact_id     uuid not null references imobi_board.contacts(id) on delete restrict,
  property_id    uuid references imobi_board.properties(id) on delete set null,
  broker_id      uuid not null references auth.users(id) on delete restrict,
  sale_value     numeric(14,2) not null check (sale_value > 0),
  sold_at        timestamptz not null default now(),
  cancelled_at   timestamptz,
  cancel_reason  text,
  source         text,
  campaign_id    text,
  campaign_name  text,
  adset_id       text,
  adset_name     text,
  ad_id          text,
  ad_name        text,
  created_at     timestamptz not null default now()
);
-- VGV por periodo e o relatorio mais pedido: indice parcial so sobre venda viva.
create index sales_vgv_idx on imobi_board.sales (tenant_id, sold_at)
  where cancelled_at is null;
create index sales_broker_idx on imobi_board.sales (broker_id, sold_at desc)
  where cancelled_at is null;
create index sales_campaign_idx on imobi_board.sales (tenant_id, campaign_id)
  where cancelled_at is null and campaign_id is not null;

alter table imobi_board.visits    enable row level security;
alter table imobi_board.proposals enable row level security;
alter table imobi_board.sales     enable row level security;

grant select, insert, update on imobi_board.visits    to authenticated;
grant select, insert, update on imobi_board.proposals to authenticated;
grant select                 on imobi_board.sales     to authenticated;

-- Corretor ve as proprias; ADMIN ve o tenant. Mesma regra da spec 12.
create policy visits_select on imobi_board.visits
  for select to authenticated
  using (broker_id = (select auth.uid())
         or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));
create policy visits_write on imobi_board.visits
  for insert to authenticated
  with check (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
              and (broker_id = (select auth.uid())
                   or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])));
create policy visits_update on imobi_board.visits
  for update to authenticated
  using (broker_id = (select auth.uid())
         or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));

create policy proposals_select on imobi_board.proposals
  for select to authenticated
  using (broker_id = (select auth.uid())
         or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));
create policy proposals_write on imobi_board.proposals
  for insert to authenticated
  with check (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
              and (broker_id = (select auth.uid())
                   or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])));
create policy proposals_update on imobi_board.proposals
  for update to authenticated
  using (broker_id = (select auth.uid())
         or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));

-- Venda: corretor ve as proprias (spec 12), ADMIN ve todas. Escrita so por RPC.
create policy sales_select on imobi_board.sales
  for select to authenticated
  using (broker_id = (select auth.uid())
         or tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));
