alter table agency_ops.clients
  add column if not exists closer_origin text not null default 'Não identificado',
  add column if not exists closer_origin_status text not null default 'UNKNOWN',
  add column if not exists closer_origin_source text,
  add column if not exists closer_origin_evidence jsonb not null default '{}'::jsonb;

comment on column agency_ops.clients.closer_origin is
  'Closer(es) de origem da venda. Usa Não identificado quando não há evidência segura.';
comment on column agency_ops.clients.closer_origin_status is
  'CONFIRMED, MULTI ou UNKNOWN conforme a força/quantidade da atribuição.';
comment on column agency_ops.clients.closer_origin_source is
  'Fonte canônica usada para atribuir o closer de origem.';
comment on column agency_ops.clients.closer_origin_evidence is
  'Metadados mínimos da evidência usada na atribuição.';

with historical(display_name, closer) as (
  values
    ('Alexsandro de Quadros','Vitor Feitoza'),
    ('Anderson Amaral','Leonardo Augusto'),
    ('Anderson Coelho','Leonardo Augusto + Vitor Feitoza'),
    ('Aurelio Coutinho','Leonardo Augusto'),
    ('Caetano e Fraga Imóveis','Leonardo Augusto'),
    ('Caio Rodrigues Vieira','Leonardo Augusto'),
    ('Century 21','Leonardo Augusto'),
    ('Charlisson Imóveis','Leonardo Augusto'),
    ('Cida Sampaio','Leonardo Augusto'),
    ('Clareza & Campos de Inhapim','Leonardo Augusto + Vitor Feitoza'),
    ('Cleverson de Arcanjo','Leonardo Augusto'),
    ('Cristiane Cardoso','Leonardo Augusto'),
    ('Daniela Vieira','Leonardo Augusto'),
    ('Davi Emanuel','Leonardo Augusto'),
    ('Deize Bonfim','Leonardo Augusto'),
    ('Dias e Barbosa','Leonardo Augusto'),
    ('Débora Direcional','Leonardo Augusto'),
    ('Euzeni','Leonardo Augusto'),
    ('Fernando Maia Imóveis','Leonardo Augusto'),
    ('Flávio Novaes','Leonardo Augusto'),
    ('FMI','Leonardo Augusto'),
    ('Héctor Cassilha','Leonardo Augusto'),
    ('Jair Pereira de Souza','Vitor Feitoza'),
    ('K2S','Leonardo Augusto + Vitor Feitoza'),
    ('Lua Imóveis Sorocaba','Leonardo Augusto'),
    ('Marcelo Timbaúba','Leonardo Augusto'),
    ('Marcos Alexandre','Leonardo Augusto'),
    ('Maria Laura','Leonardo Augusto'),
    ('MB House Imóveis','Leonardo Augusto + Vitor Feitoza'),
    ('Norma Salazar','Leonardo Augusto'),
    ('Octa','Leonardo Augusto'),
    ('Patricia Arruda','Leonardo Augusto'),
    ('Pellegrini','Leonardo Augusto'),
    ('Petronio','Leonardo Augusto'),
    ('PH Imóveis','Leonardo Augusto'),
    ('Raquel Lage','Leonardo Augusto'),
    ('Rodrigo França','Leonardo Augusto'),
    ('Ronald Chaves','Leonardo Augusto'),
    ('Samy Corretora','Leonardo Augusto + Vitor Feitoza'),
    ('Terra Concreto Imóveis','Leonardo Augusto'),
    ('Thais Rodrigues','Leonardo Augusto + Vitor Feitoza'),
    ('Victor Lacerda (BJJ)','Leonardo Augusto'),
    ('View Imóveis','Leonardo Augusto'),
    ('Wanessa Varella','Leonardo Augusto'),
    ('Welton Cunha','Leonardo Augusto')
)
update agency_ops.clients c
set closer_origin = h.closer,
    closer_origin_status = case when h.closer like '% + %' then 'MULTI' else 'CONFIRMED' end,
    closer_origin_source = 'HISTORICAL_CLOSER_AUDIT_2026-08-25',
    closer_origin_evidence = jsonb_build_object(
      'audit_file','auditoria_promessas_closers_clientes_ativos_2026-08-25.xlsx',
      'audit_date','2026-08-25'
    )
from historical h
where c.display_name = h.display_name;

update agency_ops.clients c
set closer_origin = 'Vitor Feitoza',
    closer_origin_status = 'CONFIRMED',
    closer_origin_source = 'CRM_EXACT_NAME',
    closer_origin_evidence = jsonb_build_object('matched_name','Marcondes')
where c.display_name = 'Marcondes';
update agency_ops.clients c
set closer_origin = case l.owner_id
      when '334994a0-21ee-4a6e-9a03-5fbc3a3aed00'::uuid then 'Leonardo Augusto'
      when '3d8c9014-5cc9-4af0-a940-ed404fa20eac'::uuid then 'Vitor Feitoza'
    end,
    closer_origin_status = 'CONFIRMED',
    closer_origin_source = 'CRM_LINKED',
    closer_origin_evidence = jsonb_build_object('crm_lead_id', l.id, 'owner_id', l.owner_id)
from crm.leads l
where c.crm_lead_id = l.id
  and l.owner_id in (
    '334994a0-21ee-4a6e-9a03-5fbc3a3aed00'::uuid,
    '3d8c9014-5cc9-4af0-a940-ed404fa20eac'::uuid
  );

with latest as (
  select distinct on (client_id)
    client_id, closer_names, generated_at
  from agency_ops.client_sales_promise_snapshots
  where closer_names is not null and cardinality(closer_names) > 0
  order by client_id, generated_at desc
)
update agency_ops.clients c
set closer_origin = array_to_string(latest.closer_names, ' + '),
    closer_origin_status = case when cardinality(latest.closer_names) > 1 then 'MULTI' else 'CONFIRMED' end,
    closer_origin_source = 'SALES_PROMISE_SNAPSHOT',
    closer_origin_evidence = jsonb_build_object('generated_at', latest.generated_at)
from latest
where c.id = latest.client_id;
with latest as (
  select distinct on (client_id)
    client_id, id as handoff_id, btrim(closer_name) as closer_name, created_at
  from agency_ops.onboarding_group_sales_handoff
  where btrim(coalesce(closer_name,'')) in ('Leonardo Augusto','Vitor Feitoza')
  order by client_id, created_at desc
)
update agency_ops.clients c
set closer_origin = latest.closer_name,
    closer_origin_status = 'CONFIRMED',
    closer_origin_source = 'ONBOARDING_HANDOFF',
    closer_origin_evidence = jsonb_build_object(
      'handoff_id', latest.handoff_id,
      'created_at', latest.created_at
    )
from latest
where c.id = latest.client_id;

create or replace function agency_ops.sync_client_closer_from_sales_handoff()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_id is not null
     and btrim(coalesce(new.closer_name,'')) in ('Leonardo Augusto','Vitor Feitoza') then
    update agency_ops.clients
    set closer_origin = btrim(new.closer_name),
        closer_origin_status = 'CONFIRMED',
        closer_origin_source = 'ONBOARDING_HANDOFF',
        closer_origin_evidence = jsonb_build_object('handoff_id',new.id,'created_at',new.created_at)
    where id = new.client_id;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_sync_client_closer_from_sales_handoff
on agency_ops.onboarding_group_sales_handoff;

create trigger trg_sync_client_closer_from_sales_handoff
after insert or update of closer_name, client_id
on agency_ops.onboarding_group_sales_handoff
for each row
execute function agency_ops.sync_client_closer_from_sales_handoff();

create or replace function agency_ops.sync_client_closer_from_sales_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.client_id is not null
     and new.closer_names is not null
     and cardinality(new.closer_names) > 0 then
    update agency_ops.clients
    set closer_origin = array_to_string(new.closer_names, ' + '),
        closer_origin_status = case when cardinality(new.closer_names) > 1 then 'MULTI' else 'CONFIRMED' end,
        closer_origin_source = 'SALES_PROMISE_SNAPSHOT',
        closer_origin_evidence = jsonb_build_object('generated_at',new.generated_at)
    where id = new.client_id
      and closer_origin_source is distinct from 'ONBOARDING_HANDOFF';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_sync_client_closer_from_sales_snapshot
on agency_ops.client_sales_promise_snapshots;

create trigger trg_sync_client_closer_from_sales_snapshot
after insert or update of closer_names, client_id
on agency_ops.client_sales_promise_snapshots
for each row
execute function agency_ops.sync_client_closer_from_sales_snapshot();