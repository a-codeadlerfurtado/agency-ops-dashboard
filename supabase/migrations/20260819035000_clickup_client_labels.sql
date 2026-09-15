-- Index ClickUp tasks by the client label carried in the task title: [CLIENTE].
create or replace function agency_ops.normalize_clickup_label(p_value text)
returns text
language sql
stable
parallel safe
set search_path = pg_catalog, extensions
as $$
  select nullif(
    trim(
      regexp_replace(
        regexp_replace(
          lower(extensions.unaccent(replace(replace(coalesce(p_value, ''), '&amp;', ' e '), '&', ' e '))),
          '[^a-z0-9]+', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

create or replace function agency_ops.canonical_clickup_label(p_value text)
returns text
language sql
stable
parallel safe
set search_path = pg_catalog, agency_ops
as $$
  with tokens as (
    select token, ord
    from regexp_split_to_table(coalesce(agency_ops.normalize_clickup_label(p_value), ''), '\s+') with ordinality as x(token, ord)
    where token not in (
      'de','da','do','das','dos','e','imovel','imoveis','imobiliaria','imobiliario','imobiliarios',
      'corretora','corretores','negocio','negocios','incorporadora','servico','servicos','ativo','ativos','mkt'
    )
  )
  select nullif(string_agg(token, ' ' order by ord), '') from tokens;
$$;

create or replace function agency_ops.clickup_label_token_key(p_value text)
returns text
language sql
stable
parallel safe
set search_path = pg_catalog, agency_ops
as $$
  select nullif(string_agg(token, ' ' order by token), '')
  from regexp_split_to_table(coalesce(agency_ops.canonical_clickup_label(p_value), ''), '\s+') as x(token);
$$;

create or replace function agency_ops.extract_clickup_client_label(p_task_name text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select nullif(trim((regexp_match(coalesce(p_task_name, ''), '^\s*\[([^\]]+)\]'))[1]), '');
$$;

create table if not exists agency_ops.clickup_client_aliases (
  id bigint generated always as identity primary key,
  alias text not null,
  normalized_alias text not null unique,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  match_method text not null,
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  is_manual boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table agency_ops.clickup_tasks add column if not exists client_label text;
alter table agency_ops.clickup_tasks add column if not exists client_label_normalized text;
alter table agency_ops.clickup_tasks add column if not exists client_match_confidence numeric(5,4);
alter table agency_ops.clickup_tasks add column if not exists client_match_status text;

create index if not exists idx_clickup_tasks_client_label on agency_ops.clickup_tasks(client_label_normalized);
create index if not exists idx_clickup_aliases_client on agency_ops.clickup_client_aliases(client_id) where active;

alter table agency_ops.clickup_client_aliases enable row level security;
revoke all on agency_ops.clickup_client_aliases from anon, authenticated;
grant select, insert, update, delete on agency_ops.clickup_client_aliases to service_role;
grant usage, select on sequence agency_ops.clickup_client_aliases_id_seq to service_role;

create or replace function agency_ops.refresh_clickup_client_aliases()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, agency_ops, public
as $$
declare
  affected integer := 0;
begin
  with raw_labels as (
    select agency_ops.extract_clickup_client_label(name) label
    from agency_ops.clickup_tasks
  ),
  labels as (
    select min(label) label,
           agency_ops.normalize_clickup_label(label) norm,
           agency_ops.canonical_clickup_label(label) canonical,
           agency_ops.clickup_label_token_key(label) token_key
    from raw_labels
    where label is not null
    group by agency_ops.normalize_clickup_label(label),
             agency_ops.canonical_clickup_label(label),
             agency_ops.clickup_label_token_key(label)
  ),
  clients as (
    select id, display_name,
           agency_ops.normalize_clickup_label(display_name) norm,
           agency_ops.canonical_clickup_label(display_name) canonical,
           agency_ops.clickup_label_token_key(display_name) token_key
    from agency_ops.clients
  ),
  scored as (
    select l.label, l.norm, c.id client_id,
      case
        when l.norm = c.norm then 1.0000
        when l.canonical = c.canonical and length(coalesce(l.canonical,'')) >= 2 then 0.9900
        when replace(l.norm,' ','') = replace(c.norm,' ','') and length(replace(coalesce(l.norm,''),' ','')) >= 4 then 0.9800
        when l.token_key = c.token_key and length(replace(coalesce(l.token_key,''),' ','')) >= 4 then 0.9700
        when length(coalesce(l.canonical,'')) >= 4 and (' ' || c.canonical || ' ') like ('% ' || l.canonical || ' %') then 0.9300
        when length(coalesce(c.canonical,'')) >= 4 and (' ' || l.canonical || ' ') like ('% ' || c.canonical || ' %') then 0.9200
        else public.similarity(coalesce(l.canonical,''), coalesce(c.canonical,''))::numeric
      end confidence,
      case
        when l.norm = c.norm then 'EXACT_LABEL'
        when l.canonical = c.canonical and length(coalesce(l.canonical,'')) >= 2 then 'CANONICAL_LABEL'
        when replace(l.norm,' ','') = replace(c.norm,' ','') and length(replace(coalesce(l.norm,''),' ','')) >= 4 then 'COMPACT_LABEL'
        when l.token_key = c.token_key and length(replace(coalesce(l.token_key,''),' ','')) >= 4 then 'TOKEN_SET_LABEL'
        when length(coalesce(l.canonical,'')) >= 4 and (' ' || c.canonical || ' ') like ('% ' || l.canonical || ' %') then 'LABEL_PREFIX'
        when length(coalesce(c.canonical,'')) >= 4 and (' ' || l.canonical || ' ') like ('% ' || c.canonical || ' %') then 'CLIENT_PREFIX'
        else 'FUZZY_LABEL'
      end match_method
    from labels l cross join clients c
    where l.norm is not null and l.norm <> 'sem cliente especifico'
  ),
  ranked as (
    select *, row_number() over(partition by norm order by confidence desc, client_id) rank,
           lead(confidence) over(partition by norm order by confidence desc, client_id) second_confidence
    from scored
  ),
  accepted as (
    select label, norm, client_id, match_method, confidence
    from ranked
    where rank = 1 and (
      (match_method in ('EXACT_LABEL','CANONICAL_LABEL','COMPACT_LABEL','TOKEN_SET_LABEL') and confidence > coalesce(second_confidence, -1))
      or (confidence >= 0.9000 and confidence - coalesce(second_confidence, 0) >= 0.0600)
      or (confidence >= 0.7800 and confidence - coalesce(second_confidence, 0) >= 0.1500)
    )
  )
  insert into agency_ops.clickup_client_aliases(alias, normalized_alias, client_id, match_method, confidence)
  select label, norm, client_id, match_method, confidence from accepted
  on conflict(normalized_alias) do update
    set alias=excluded.alias, client_id=excluded.client_id, match_method=excluded.match_method,
        confidence=excluded.confidence, active=true, updated_at=now()
  where not agency_ops.clickup_client_aliases.is_manual;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

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

create or replace view agency_ops.clickup_client_label_audit
with (security_invoker=true)
as
select t.client_label,
       t.client_label_normalized,
       count(*)::integer task_count,
       a.client_id,
       c.display_name client_name,
       c.lifecycle,
       a.match_method,
       a.confidence,
       case
         when t.client_label_normalized is null then 'NO_LABEL'
         when a.client_id is null then 'UNMATCHED'
         else 'MATCHED'
       end status
from agency_ops.clickup_tasks t
left join agency_ops.clickup_client_aliases a on a.normalized_alias=t.client_label_normalized and a.active
left join agency_ops.clients c on c.id=a.client_id
group by t.client_label,t.client_label_normalized,a.client_id,c.display_name,c.lifecycle,a.match_method,a.confidence;

revoke all on function agency_ops.refresh_clickup_client_aliases() from public, anon, authenticated;
revoke all on function agency_ops.reindex_clickup_task_clients() from public, anon, authenticated;
grant execute on function agency_ops.refresh_clickup_client_aliases() to service_role;
grant execute on function agency_ops.reindex_clickup_task_clients() to service_role;
grant select on agency_ops.clickup_client_label_audit to service_role;

select agency_ops.refresh_clickup_client_aliases();

-- Confident business aliases that cannot be inferred safely from generic suffix removal alone.
insert into agency_ops.clickup_client_aliases(alias,normalized_alias,client_id,match_method,confidence,is_manual)
select seed.alias, agency_ops.normalize_clickup_label(seed.alias), c.id, 'MANUAL_ALIAS', 1.0000, true
from (values
  ('MB','MB House Imóveis'),
  ('FR PRIME','FR Imóveis'),
  ('VICTOR BJJ','Victor Lacerda (BJJ)'),
  ('VITOR BJJ','Victor Lacerda (BJJ)'),
  ('GIULIANO','GIU Holtz'),
  ('GIULIANO HOLTZ','GIU Holtz')
) seed(alias,client_name)
join agency_ops.clients c on c.display_name=seed.client_name
on conflict(normalized_alias) do update
  set client_id=excluded.client_id, match_method=excluded.match_method, confidence=excluded.confidence,
      is_manual=true, active=true, updated_at=now();

select agency_ops.reindex_clickup_task_clients();
