-- Curated aliases confirmed by the bracket label, existing client records and task context.
create table if not exists agency_ops.clickup_task_client_overrides (
  task_id text primary key references agency_ops.clickup_tasks(task_id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  reason text not null,
  confidence numeric(5,4) not null default 1.0000 check(confidence between 0 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table agency_ops.clickup_task_client_overrides enable row level security;
revoke all on agency_ops.clickup_task_client_overrides from anon, authenticated;
grant select, insert, update, delete on agency_ops.clickup_task_client_overrides to service_role;

with seeds(alias,client_name) as (values
  ('UNIC','Unic Imóveis'),
  ('UNIC IMOVEIS','Unic Imóveis'),
  ('UNIC IMÓVEIS','Unic Imóveis'),
  ('UNIC IMOVEIS CAMBORIU','Unic Imóveis'),
  ('UNIC IMÓVEIS CAMBORIU','Unic Imóveis'),
  ('UNIC IMOVEIW','Unic Imóveis'),
  ('KROLOW','Krollow'),
  ('LUA','Lua Imóveis Sorocaba'),
  ('LUA IMOVEIS','Lua Imóveis Sorocaba'),
  ('LUA IMÓVEIS','Lua Imóveis Sorocaba'),
  ('IDEALLI','Ideali Imóveis'),
  ('MARCOS ALEXADRE','Marcos Alexandre'),
  ('NILTON SOUSA','Nilton Souza'),
  ('NILSTON SOUSA','Nilton Souza'),
  ('MB IMÓVEIS','MB House Imóveis'),
  ('JAIR CORRETOR DE IMÓVEIS','Jair Pereira de Souza'),
  ('AURELIO','Aurelio Coutinho'),
  ('GERAL','Imóveis Geraldo'),
  ('ADILSON JUNIOR','Adilson Jr.'),
  ('ALEXANDRO QUADROS','Alexsandro de Quadros'),
  ('AYRTON','Airton'),
  ('CENTRURY 21','Century 21'),
  ('CETRAL CASA PROPRIA','Central da Casa Própria'),
  ('CLAREZA E TERRAS DE INHAPIM','Clareza &amp; Campos de Inhapim'),
  ('CLEITON GREGOR','Cleiton Gregol'),
  ('CLEVESON','Cleverson de Arcanjo'),
  ('CORE INVES','Core Investt'),
  ('DOMUN','Domus Serviços Imobiliários'),
  ('FAMILI BROKER','Family Broker'),
  ('HCC','HC Imóveis'),
  ('JULIANA MUSTAFFA','Julianna Mustaffa'),
  ('JULIANA MUSTAFA','Julianna Mustaffa'),
  ('JULISNA MUSTAFFA','Julianna Mustaffa'),
  ('LEONARDRO CREMER','Leonardo Cremer'),
  ('LUCIANO FUNCH','Luciano Fuchs'),
  ('MARCIA PACHEGO','Marcia Pacheco'),
  ('MARCUS AURELIO','Marco Aurélio'),
  ('MAXWELL RIBEIRO','Maxuel Ribeiro'),
  ('PELLEGRINE','Pellegrini'),
  ('Paulo Segio','Paulo Sérgio'),
  ('RAFFAEL LORENCO','Raffael Lourenço'),
  ('NS','NS Cinco Imóveis'),
  ('FABIO','Fábio Coelho'),
  ('MARCELO','Marcelo Henrique'),
  ('PAULO','Paulo Sérgio'),
  ('DAVI','Davi Emanuel')
),
prepared as (
  select min(alias) alias, agency_ops.normalize_clickup_label(alias) normalized_alias, client_name
  from seeds
  group by agency_ops.normalize_clickup_label(alias),client_name
)
insert into agency_ops.clickup_client_aliases(alias,normalized_alias,client_id,match_method,confidence,is_manual)
select seed.alias, seed.normalized_alias, c.id, 'MANUAL_CROSSCHECK', 1.0000, true
from prepared seed
join agency_ops.clients c on c.display_name=seed.client_name
on conflict(normalized_alias) do update
  set client_id=excluded.client_id, match_method=excluded.match_method, confidence=excluded.confidence,
      is_manual=true, active=true, updated_at=now();

-- The short DAVI label was reused. Earlier D6/Camboriú tasks belong to Davi Silveira;
-- the current label belongs to Davi Emanuel and is handled by the alias above.
insert into agency_ops.clickup_task_client_overrides(task_id,client_id,reason,confidence)
select t.task_id,c.id,'DAVI label cross-checked by date and D6/Camboriu task context',1.0000
from agency_ops.clickup_tasks t
join agency_ops.clients c on c.display_name='Davi Silveira'
where t.client_label_normalized='davi'
  and t.date_closed < '2026-07-01 00:00:00-03'::timestamptz
on conflict(task_id) do update
  set client_id=excluded.client_id,reason=excluded.reason,confidence=excluded.confidence,updated_at=now();

-- These labels are not a single client and must never be auto-attributed.
update agency_ops.clickup_client_aliases
set active=false,is_manual=true,match_method='BLOCKED_AMBIGUOUS',updated_at=now()
where normalized_alias in ('caio sizino','banco de imoveis');

create or replace function agency_ops.reindex_clickup_task_clients()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, agency_ops
as $$
declare
  result jsonb;
begin
  update agency_ops.clickup_tasks
     set client_label = agency_ops.extract_clickup_client_label(name),
         client_label_normalized = agency_ops.normalize_clickup_label(agency_ops.extract_clickup_client_label(name));

  update agency_ops.clickup_tasks t
     set client_id = a.client_id,
         client_match_source = 'BRACKET_' || a.match_method,
         client_match_confidence = a.confidence,
         client_match_status = 'MATCHED'
    from agency_ops.clickup_client_aliases a
   where t.client_label_normalized = a.normalized_alias and a.active;

  update agency_ops.clickup_tasks t
     set client_id = null,
         client_match_source = 'BRACKET_UNMATCHED',
         client_match_confidence = null,
         client_match_status = 'UNMATCHED'
   where t.client_label_normalized is not null
     and not exists (
       select 1 from agency_ops.clickup_client_aliases a
       where a.normalized_alias=t.client_label_normalized and a.active
     );

  update agency_ops.clickup_tasks
     set client_match_status = case when client_id is null then 'NO_LABEL' else 'MATCHED' end,
         client_match_confidence = case when client_id is null then null else coalesce(client_match_confidence,0.8000) end,
         client_match_source = case when client_id is null then 'NO_BRACKET_LABEL' else coalesce(client_match_source,'LEGACY_CONTEXT_NAME') end
   where client_label_normalized is null;

  update agency_ops.clickup_tasks t
     set client_id=o.client_id,
         client_match_source='TASK_OVERRIDE',
         client_match_confidence=o.confidence,
         client_match_status='MATCHED'
    from agency_ops.clickup_task_client_overrides o
   where o.task_id=t.task_id;

  select jsonb_build_object(
    'total',count(*),
    'matched',count(*) filter(where client_id is not null),
    'unmatched_label',count(*) filter(where client_match_status='UNMATCHED'),
    'without_label',count(*) filter(where client_match_status='NO_LABEL'),
    'clients_indexed',count(distinct client_id)
  ) into result
  from agency_ops.clickup_tasks;
  return result;
end;
$$;

select agency_ops.reindex_clickup_task_clients();
