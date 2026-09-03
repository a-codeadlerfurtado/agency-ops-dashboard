-- Imobi-Board 0010 - imoveis, empreendimentos e perfil de interesse
-- (spec PASSOS 14/15, secoes 36-40)

create type imobi_board.property_type as enum
  ('APARTAMENTO','CASA','SOBRADO','COBERTURA','TERRENO','SALA','GALPAO','CHACARA');
create type imobi_board.transaction_type as enum ('VENDA','LOCACAO');
create type imobi_board.property_status as enum ('AVAILABLE','RESERVED','SOLD','INACTIVE');
create type imobi_board.purchase_purpose as enum ('MORAR','INVESTIR','INDEFINIDO');

-- Empreendimento: o guarda-chuva de varias unidades (spec 36).
create table imobi_board.developments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references imobi_board.tenants(id) on delete cascade,
  name         text not null,
  city         text,
  state        char(2),
  neighborhood text,
  address      text,
  status       imobi_board.property_status not null default 'AVAILABLE',
  delivery_at  date,
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index developments_tenant_idx on imobi_board.developments (tenant_id);
create trigger developments_touch before update on imobi_board.developments
  for each row execute function imobi_board_priv.touch_updated_at();

-- Imovel. Serve tanto usado avulso quanto unidade de empreendimento: a unica
-- diferenca e development_id estar preenchido. Uma tabela em vez de duas
-- (properties + property_units) porque as duas teriam as mesmas 20 colunas.
create table imobi_board.properties (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references imobi_board.tenants(id) on delete cascade,
  development_id   uuid references imobi_board.developments(id) on delete set null,
  code             text,
  title            text not null,
  type             imobi_board.property_type not null,
  transaction_type imobi_board.transaction_type not null default 'VENDA',
  status           imobi_board.property_status not null default 'AVAILABLE',
  address          text,
  city             text,
  state            char(2),
  neighborhood     text,
  zip              text,
  price            numeric(14,2) check (price is null or price >= 0),
  condo_fee        numeric(12,2),
  property_tax     numeric(12,2),
  area_m2          numeric(10,2) check (area_m2 is null or area_m2 > 0),
  bedrooms         smallint check (bedrooms is null or bedrooms between 0 and 20),
  suites           smallint check (suites is null or suites between 0 and 20),
  bathrooms        smallint check (bathrooms is null or bathrooms between 0 and 20),
  parking_spaces   smallint check (parking_spaces is null or parking_spaces between 0 and 20),
  description      text,
  features         text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, code)
);
-- O matching filtra por tenant + status e depois por bairro/preco. Indice
-- parcial: imovel vendido ou inativo nao entra em busca nenhuma.
create index properties_busca_idx
  on imobi_board.properties (tenant_id, neighborhood, price)
  where status = 'AVAILABLE';
create index properties_tenant_status_idx
  on imobi_board.properties (tenant_id, status, created_at desc);
create index properties_development_idx
  on imobi_board.properties (development_id) where development_id is not null;
create trigger properties_touch before update on imobi_board.properties
  for each row execute function imobi_board_priv.touch_updated_at();

create table imobi_board.property_media (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references imobi_board.tenants(id) on delete cascade,
  property_id  uuid not null references imobi_board.properties(id) on delete cascade,
  storage_path text not null,
  media_type   text not null default 'image',
  sort_order   smallint not null default 0,
  created_at   timestamptz not null default now()
);
create index property_media_idx on imobi_board.property_media (property_id, sort_order);

-- as FKs que a 0001 deixou soltas
alter table imobi_board.opportunities
  add constraint opportunities_property_fk
    foreign key (property_id) references imobi_board.properties(id) on delete set null,
  add constraint opportunities_development_fk
    foreign key (development_id) references imobi_board.developments(id) on delete set null;

-- Perfil de interesse (spec 40). Um por oportunidade: e o interesse DAQUELA
-- busca, nao da pessoa - a mesma pessoa pode querer coisas diferentes depois.
create table imobi_board.lead_interests (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references imobi_board.tenants(id) on delete cascade,
  opportunity_id     uuid not null unique references imobi_board.opportunities(id) on delete cascade,
  purchase_purpose   imobi_board.purchase_purpose not null default 'INDEFINIDO',
  property_type      imobi_board.property_type,
  cities             text[] not null default '{}',
  neighborhoods      text[] not null default '{}',
  min_price          numeric(14,2),
  max_price          numeric(14,2),
  min_area           numeric(10,2),
  max_area           numeric(10,2),
  min_bedrooms       smallint,
  min_suites         smallint,
  min_parking_spaces smallint,
  financing_needed   boolean,
  down_payment       numeric(14,2),
  purchase_timeframe text,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint lead_interests_preco_ck
    check (min_price is null or max_price is null or min_price <= max_price)
);
create index lead_interests_tenant_idx on imobi_board.lead_interests (tenant_id);
create trigger lead_interests_touch before update on imobi_board.lead_interests
  for each row execute function imobi_board_priv.touch_updated_at();

alter table imobi_board.developments   enable row level security;
alter table imobi_board.properties     enable row level security;
alter table imobi_board.property_media enable row level security;
alter table imobi_board.lead_interests enable row level security;

-- Imovel e do tenant inteiro: corretor precisa ver o estoque para vender
-- (spec 12 diz "imoveis liberados para o tenant"). So ADMIN cadastra e edita.
grant select on imobi_board.developments   to authenticated;
grant select on imobi_board.properties     to authenticated;
grant select on imobi_board.property_media to authenticated;
grant insert, update, delete on imobi_board.developments   to authenticated;
grant insert, update, delete on imobi_board.properties     to authenticated;
grant insert, update, delete on imobi_board.property_media to authenticated;
grant select, insert, update, delete on imobi_board.lead_interests to authenticated;

create policy developments_select on imobi_board.developments
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));
create policy developments_admin on imobi_board.developments
  for all to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

create policy properties_select on imobi_board.properties
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));
create policy properties_admin on imobi_board.properties
  for all to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

create policy property_media_select on imobi_board.property_media
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[]));
create policy property_media_admin on imobi_board.property_media
  for all to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]))
  with check (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

-- interesse acompanha a oportunidade: quem atende o lead preenche
create policy lead_interests_select on imobi_board.lead_interests
  for select to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    or imobi_board_priv.owns_opportunity(opportunity_id)
  );
create policy lead_interests_write on imobi_board.lead_interests
  for all to authenticated
  using (
    tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
    or imobi_board_priv.owns_opportunity(opportunity_id)
  )
  with check (
    tenant_id = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
    and (
      tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
      or imobi_board_priv.owns_opportunity(opportunity_id)
    )
  );
