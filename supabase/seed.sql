-- =========================================================================
-- Imobi-Board - seed de demonstracao (spec 94-97)
--
-- Dois tenants de proposito: um so nao prova isolamento nenhum. Entre como
-- Carlos (Terra Concreta) e como Beatriz (Horizonte) e confira que nenhum ve
-- o dado do outro.
--
-- Contas ficticias, dominios .demo, senha unica de demonstracao. NAO usar em
-- producao: troque a senha e remova estes usuarios antes.
-- =========================================================================

-- ---------------------------------------------------------------- usuarios
-- As colunas de token do auth.users precisam ser string vazia, nunca NULL:
-- com NULL o GoTrue devolve 500 no login. Cada usuario tambem precisa de uma
-- linha em auth.identities com provider 'email'.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new,
  email_change_token_current, email_change, phone_change, phone_change_token,
  reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000',
  u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('ImobiBoard#Demo2026', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', u.nome),
  now(), now(),
  '', '', '', '', '', '', '', ''
from (values
  ('11111111-1111-4111-8111-000000000001'::uuid, 'carlos@terraconcreta.demo', 'Carlos Menezes'),
  ('11111111-1111-4111-8111-000000000002'::uuid, 'joao@terraconcreta.demo',   'Joao Silva'),
  ('11111111-1111-4111-8111-000000000003'::uuid, 'maria@terraconcreta.demo',  'Maria Fernandes'),
  ('11111111-1111-4111-8111-000000000004'::uuid, 'pedro@terraconcreta.demo',  'Pedro Almeida'),
  ('22222222-2222-4222-8222-000000000001'::uuid, 'beatriz@horizonte.demo',    'Beatriz Rocha'),
  ('22222222-2222-4222-8222-000000000002'::uuid, 'rafael@horizonte.demo',     'Rafael Lima')
) as u(id, email, nome)
on conflict (id) do nothing;

insert into auth.identities (id, user_id, identity_data, provider, provider_id,
                             last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id,
       jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
       'email', u.id::text, now(), now(), now()
from auth.users u
where (u.email like '%@terraconcreta.demo' or u.email like '%@horizonte.demo')
  and not exists (select 1 from auth.identities i
                  where i.user_id = u.id and i.provider = 'email');

insert into imobi_board.profiles (id, full_name)
select u.id, u.raw_user_meta_data ->> 'full_name'
from auth.users u
where u.email like '%@terraconcreta.demo' or u.email like '%@horizonte.demo'
on conflict (id) do nothing;

-- ----------------------------------------------------------------- tenants
insert into imobi_board.tenants (id, name, slug) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Terra Concreta',        'terra-concreta'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'Imobiliaria Horizonte', 'imobiliaria-horizonte')
on conflict (id) do nothing;

insert into imobi_board.memberships (tenant_id, user_id, role) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-000000000001', 'ADMIN'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-000000000002', 'BROKER'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-000000000003', 'BROKER'),
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-000000000004', 'BROKER'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-000000000001', 'ADMIN'),
  ('bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-000000000002', 'BROKER')
on conflict (tenant_id, user_id) do nothing;

-- ------------------------------------------------------------------- funis
insert into imobi_board.pipelines (id, tenant_id, name, is_default) values
  ('aaaaaaaa-1111-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Funil padrao', true),
  ('bbbbbbbb-1111-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-000000000002', 'Funil padrao', true)
on conflict (id) do nothing;

-- NOT EXISTS em vez de ON CONFLICT: a unique de ordenacao e DEFERRABLE e nao
-- pode ser arbitro de ON CONFLICT.
insert into imobi_board.pipeline_stages (tenant_id, pipeline_id, name, kind, sort_order)
select p.tenant_id, p.id, s.nome, s.kind::imobi_board.stage_kind, s.ord
from imobi_board.pipelines p
cross join (values
  ('Novo','NEW',0),('Contatado','CONTACTED',1),('Qualificado','QUALIFIED',2),
  ('Visita','VISIT',3),('Proposta','PROPOSAL',4),('Venda','WON',5)
) as s(nome, kind, ord)
where not exists (
  select 1 from imobi_board.pipeline_stages ps
  where ps.pipeline_id = p.id and ps.sort_order = s.ord);

-- ------------------------------------------- 24 oportunidades Terra Concreta
-- Distribuidas em formato de funil (mais no topo), por corretor e por origem.
-- Duas ficam sem dono de proposito: sao a "fila", invisivel para BROKER.
-- Seis ficam com 35 dias sem interacao, para exercitar leads esquecidos.
with nomes as (
  select array[
    'Ana Beatriz Souza','Bruno Carvalho','Camila Nogueira','Diego Ferraz',
    'Eduarda Pinto','Fabio Rezende','Gabriela Matos','Henrique Dias',
    'Isabela Cunha','Joao Pedro Vieira','Karina Lopes','Leandro Braga',
    'Mariana Teixeira','Nelson Aguiar','Olivia Ramos','Paulo Sergio Mota',
    'Queila Barbosa','Rodrigo Prado','Sabrina Freitas','Thiago Marques',
    'Ursula Campos','Vinicius Salles','Wanessa Duarte','Xavier Andrade'] as n
),
g as (
  select i, (select n[i] from nomes) as nome,
    '11' || lpad((900000000 + i * 137)::text, 9, '0') as fone,
    (array['META_ADS','META_ADS','GOOGLE','INDICACAO','MANUAL'])[1 + (i % 5)] as origem,
    case when i <= 8 then 'NEW' when i <= 14 then 'CONTACTED'
         when i <= 18 then 'QUALIFIED' when i <= 21 then 'VISIT'
         when i <= 23 then 'PROPOSAL' else 'WON' end::imobi_board.stage_kind as kind,
    case when i <= 2 then null else (array[
      '11111111-1111-4111-8111-000000000002'::uuid,
      '11111111-1111-4111-8111-000000000003'::uuid,
      '11111111-1111-4111-8111-000000000004'::uuid])[1 + (i % 3)] end as corretor,
    now() - ((i * 2.3) || ' days')::interval as entrou,
    case when i between 3 and 8 then now() - interval '35 days'
         else now() - ((i % 6) || ' days')::interval end as ultima
  from generate_series(1, 24) i
),
c as (
  insert into imobi_board.contacts (tenant_id, full_name, phone, phone_normalized, created_at)
  select 'aaaaaaaa-0000-4000-8000-000000000001', g.nome, g.fone,
         imobi_board_priv.normalize_phone_br(g.fone), g.entrou
  from g returning id, full_name
)
insert into imobi_board.opportunities (
  tenant_id, contact_id, assigned_user_id, pipeline_id, stage_id, status, source,
  campaign_id, campaign_name, adset_name, ad_name, created_at, first_assigned_at,
  accepted_at, first_contact_at, qualified_at, closed_at, last_interaction_at)
select 'aaaaaaaa-0000-4000-8000-000000000001', c.id, g.corretor,
  'aaaaaaaa-1111-4000-8000-000000000001', s.id,
  case when g.kind = 'WON' then 'WON' else 'OPEN' end::imobi_board.opp_status,
  g.origem,
  case when g.origem = 'META_ADS' then '1201' || g.i::text end,
  case when g.origem = 'META_ADS' then 'Lancamento Vista Residence' end,
  case when g.origem = 'META_ADS' then 'Interesse 3 quartos' end,
  case when g.origem = 'META_ADS' then 'Video tour 30s' end,
  g.entrou,
  case when g.corretor is not null then g.entrou + interval '4 minutes' end,
  case when g.corretor is not null and g.kind <> 'NEW' then g.entrou + interval '9 minutes' end,
  case when g.kind <> 'NEW' then g.entrou + interval '40 minutes' end,
  case when g.kind in ('QUALIFIED','VISIT','PROPOSAL','WON') then g.entrou + interval '2 days' end,
  case when g.kind = 'WON' then g.entrou + interval '21 days' end,
  g.ultima
from g
join c on c.full_name = g.nome
join imobi_board.pipeline_stages s
  on s.pipeline_id = 'aaaaaaaa-1111-4000-8000-000000000001' and s.kind = g.kind;

-- --------------------------------------------- 6 oportunidades na Horizonte
with g as (
  select i,
    (array['Alberto Nunes','Bianca Rios','Cesar Toledo','Denise Antunes',
           'Elias Portela','Flavia Correia'])[i] as nome,
    '61' || lpad((980000000 + i * 211)::text, 9, '0') as fone,
    (array['META_ADS','GOOGLE','MANUAL'])[1 + (i % 3)] as origem,
    (array['NEW','NEW','CONTACTED','QUALIFIED','VISIT','PROPOSAL'])[i]::imobi_board.stage_kind as kind,
    now() - ((i * 3) || ' days')::interval as entrou
  from generate_series(1, 6) i
),
c as (
  insert into imobi_board.contacts (tenant_id, full_name, phone, phone_normalized, created_at)
  select 'bbbbbbbb-0000-4000-8000-000000000002', g.nome, g.fone,
         imobi_board_priv.normalize_phone_br(g.fone), g.entrou
  from g returning id, full_name
)
insert into imobi_board.opportunities (
  tenant_id, contact_id, assigned_user_id, pipeline_id, stage_id, source,
  created_at, first_assigned_at, first_contact_at, last_interaction_at)
select 'bbbbbbbb-0000-4000-8000-000000000002', c.id,
  case when g.i <= 2 then null else '22222222-2222-4222-8222-000000000002'::uuid end,
  'bbbbbbbb-1111-4000-8000-000000000002', s.id, g.origem, g.entrou,
  case when g.i > 2 then g.entrou + interval '3 minutes' end,
  case when g.kind <> 'NEW' then g.entrou + interval '25 minutes' end,
  g.entrou
from g
join c on c.full_name = g.nome
join imobi_board.pipeline_stages s
  on s.pipeline_id = 'bbbbbbbb-1111-4000-8000-000000000002' and s.kind = g.kind;

-- ---------------------------------------------------------------- historico
insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by, created_at)
select o.tenant_id, o.id, 'SYSTEM', 'Oportunidade criada. Origem: ' || o.source,
  coalesce(o.assigned_user_id,
    case when o.tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001'
         then '11111111-1111-4111-8111-000000000001'::uuid
         else '22222222-2222-4222-8222-000000000001'::uuid end),
  o.created_at
from imobi_board.opportunities o;

insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by, created_at)
select o.tenant_id, o.id, 'WHATSAPP',
       'Primeiro contato feito pelo WhatsApp. Cliente pediu mais fotos.',
       o.assigned_user_id, o.first_contact_at
from imobi_board.opportunities o
where o.first_contact_at is not null and o.assigned_user_id is not null;

-- o trigger de atividade sobrescreve last_interaction_at; recoloca os valores
update imobi_board.opportunities o
   set last_interaction_at = case
     when o.tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001'
          and o.created_at < now() - interval '7 days'
          and o.status = 'OPEN'
          and o.stage_id in (select id from imobi_board.pipeline_stages
                             where pipeline_id = 'aaaaaaaa-1111-4000-8000-000000000001'
                               and kind = 'NEW')
     then now() - interval '35 days'
     else greatest(o.created_at, now() - interval '6 days') end;

-- ----------------------------------------------------- follow-ups do Joao
insert into imobi_board.tasks (tenant_id, opportunity_id, assigned_user_id, title,
                               due_at, status, created_by)
select o.tenant_id, o.id, o.assigned_user_id,
       'Retornar contato - ' || c.full_name,
       now() + ((row_number() over (order by o.created_at)) - 3) * interval '1 day',
       'OPEN', o.assigned_user_id
from imobi_board.opportunities o
join imobi_board.contacts c on c.id = o.contact_id
where o.assigned_user_id = '11111111-1111-4111-8111-000000000002'
limit 6;

-- ------------------------------------------------- fila de plantao + ingest
insert into imobi_board.lead_queues (id, tenant_id, name, acceptance_timeout_seconds)
values ('cccccccc-0000-4000-8000-000000000001',
        'aaaaaaaa-0000-4000-8000-000000000001', 'Plantao Vista Residence', 300)
on conflict (id) do nothing;

insert into imobi_board.queue_members (tenant_id, queue_id, user_id, sort_order) values
  ('aaaaaaaa-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-000000000002',0),
  ('aaaaaaaa-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-000000000003',1),
  ('aaaaaaaa-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','11111111-1111-4111-8111-000000000004',2)
on conflict (queue_id, user_id) do nothing;

-- Credencial de ingestao de demonstracao.
-- Token em claro: imobi_demo_terra_concreta_2026
-- Em producao o token e gerado aleatoriamente e mostrado uma unica vez.
insert into imobi_board.ingest_sources (tenant_id, integration, label, token_sha256, queue_id)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'META_ADS',
        'Meta Lead Ads - Vista Residence',
        encode(extensions.digest('imobi_demo_terra_concreta_2026', 'sha256'), 'hex'),
        'cccccccc-0000-4000-8000-000000000001')
on conflict (token_sha256) do nothing;
