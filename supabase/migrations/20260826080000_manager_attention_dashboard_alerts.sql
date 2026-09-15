create table if not exists agency_ops.manager_attention_alerts (
  id uuid primary key default gen_random_uuid(),
  issue_key text not null unique,
  run_id bigint null,
  run_date date not null,
  first_seen_slot text not null,
  last_seen_slot text not null,
  client_id text null,
  client_name text not null,
  level text not null check (level in ('COBRAR_AGORA','ACOMPANHAR_HOJE','VERIFICAR_INTERNO')),
  priority text not null default 'MEDIUM',
  owner_area text null,
  owner_person text null,
  context text null,
  situation text null,
  charge_action text null,
  confidence text null,
  candidate_score integer not null default 0,
  occurrence_count integer not null default 1,
  status text not null default 'OPEN' check (status in ('OPEN','COBRADO','RESOLVIDO','AGUARDANDO_CLIENTE','PRAZO_COMBINADO','FALSO_POSITIVO')),
  action_note text null,
  action_by text null,
  action_at timestamptz null,
  snoozed_until timestamptz null,
  allowed_people text[] not null default array['Adler Furtado','Joel Antoniete','Gustavo Lima']::text[],
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists manager_attention_alerts_status_idx on agency_ops.manager_attention_alerts(status, last_seen_at desc);
create index if not exists manager_attention_alerts_client_idx on agency_ops.manager_attention_alerts(client_id, last_seen_at desc);

alter table agency_ops.manager_attention_alerts enable row level security;
drop policy if exists manager_attention_alerts_select_allowed on agency_ops.manager_attention_alerts;
create policy manager_attention_alerts_select_allowed on agency_ops.manager_attention_alerts for select to authenticated
using (agency_ops.current_authenticated_collaborator_person() = any(allowed_people));

revoke all on agency_ops.manager_attention_alerts from anon, authenticated;
grant usage on schema agency_ops to authenticated;
grant select on agency_ops.manager_attention_alerts to authenticated;

create or replace function agency_ops.upsert_manager_attention_alert(p_run_id bigint,p_run_date date,p_slot text,p_item jsonb)
returns uuid language plpgsql security definer set search_path = pg_catalog, agency_ops, public, extensions as $$
declare
  v_id uuid;
  v_client_id text := nullif(p_item->>'client_id','');
  v_client_name text := coalesce(nullif(p_item->>'client_name',''),'Cliente');
  v_level text := coalesce(nullif(p_item->>'level',''),'VERIFICAR_INTERNO');
  v_issue_key text;
begin
  if v_level not in ('COBRAR_AGORA','ACOMPANHAR_HOJE','VERIFICAR_INTERNO') then raise exception 'invalid manager attention level: %', v_level; end if;
  v_issue_key := p_run_date::text || ':' || coalesce(v_client_id, lower(v_client_name)) || ':' || md5(coalesce(p_item->>'charge_action','') || '|' || coalesce(p_item->>'situation',''));
  insert into agency_ops.manager_attention_alerts(issue_key,run_id,run_date,first_seen_slot,last_seen_slot,client_id,client_name,level,priority,owner_area,owner_person,context,situation,charge_action,confidence,candidate_score)
  values(v_issue_key,p_run_id,p_run_date,p_slot,p_slot,v_client_id,v_client_name,v_level,coalesce(nullif(p_item->>'priority',''),'MEDIUM'),nullif(p_item->>'owner_area',''),nullif(p_item->>'owner_person',''),nullif(p_item->>'context',''),nullif(p_item->>'situation',''),nullif(p_item->>'charge_action',''),nullif(p_item->>'confidence',''),coalesce((p_item->>'candidate_score')::integer,0))
  on conflict(issue_key) do update set
    run_id=excluded.run_id,last_seen_slot=excluded.last_seen_slot,level=excluded.level,priority=excluded.priority,owner_area=excluded.owner_area,owner_person=excluded.owner_person,context=excluded.context,situation=excluded.situation,charge_action=excluded.charge_action,confidence=excluded.confidence,candidate_score=excluded.candidate_score,
    occurrence_count=case when agency_ops.manager_attention_alerts.last_seen_slot is distinct from excluded.last_seen_slot then agency_ops.manager_attention_alerts.occurrence_count+1 else agency_ops.manager_attention_alerts.occurrence_count end,
    status=case
      when agency_ops.manager_attention_alerts.status in ('RESOLVIDO','FALSO_POSITIVO') then agency_ops.manager_attention_alerts.status
      when agency_ops.manager_attention_alerts.status in ('AGUARDANDO_CLIENTE','PRAZO_COMBINADO') and agency_ops.manager_attention_alerts.snoozed_until is not null and agency_ops.manager_attention_alerts.snoozed_until>now() then agency_ops.manager_attention_alerts.status
      when agency_ops.manager_attention_alerts.last_seen_slot is distinct from excluded.last_seen_slot then 'OPEN'
      else agency_ops.manager_attention_alerts.status end,
    action_note=case when agency_ops.manager_attention_alerts.last_seen_slot is distinct from excluded.last_seen_slot and agency_ops.manager_attention_alerts.status not in ('RESOLVIDO','FALSO_POSITIVO','AGUARDANDO_CLIENTE','PRAZO_COMBINADO') then null else agency_ops.manager_attention_alerts.action_note end,
    action_by=case when agency_ops.manager_attention_alerts.last_seen_slot is distinct from excluded.last_seen_slot and agency_ops.manager_attention_alerts.status not in ('RESOLVIDO','FALSO_POSITIVO','AGUARDANDO_CLIENTE','PRAZO_COMBINADO') then null else agency_ops.manager_attention_alerts.action_by end,
    action_at=case when agency_ops.manager_attention_alerts.last_seen_slot is distinct from excluded.last_seen_slot and agency_ops.manager_attention_alerts.status not in ('RESOLVIDO','FALSO_POSITIVO','AGUARDANDO_CLIENTE','PRAZO_COMBINADO') then null else agency_ops.manager_attention_alerts.action_at end,
    last_seen_at=now(),updated_at=now()
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function agency_ops.upsert_manager_attention_alert(bigint,date,text,jsonb) from public;

create or replace function agency_ops.manager_attention_alert_action(p_id uuid,p_action text,p_note text default null,p_snoozed_until timestamptz default null)
returns agency_ops.manager_attention_alerts language plpgsql security definer set search_path = pg_catalog, agency_ops, public, extensions as $$
declare v_actor text; v_row agency_ops.manager_attention_alerts; v_action text:=upper(trim(coalesce(p_action,'')));
begin
  v_actor:=agency_ops.current_authenticated_collaborator_person(); if v_actor is null then raise exception 'unauthorized'; end if;
  select * into v_row from agency_ops.manager_attention_alerts where id=p_id and v_actor=any(allowed_people) for update;
  if not found then raise exception 'alert_not_found_or_forbidden'; end if;
  if v_action not in ('COBRADO','RESOLVIDO','AGUARDANDO_CLIENTE','PRAZO_COMBINADO','FALSO_POSITIVO') then raise exception 'invalid_action'; end if;
  if v_action in ('AGUARDANDO_CLIENTE','PRAZO_COMBINADO') and p_snoozed_until is null then raise exception 'snoozed_until_required'; end if;
  update agency_ops.manager_attention_alerts set status=v_action,action_note=nullif(trim(coalesce(p_note,'')),''),action_by=v_actor,action_at=now(),snoozed_until=case when v_action in ('AGUARDANDO_CLIENTE','PRAZO_COMBINADO') then p_snoozed_until else null end,updated_at=now() where id=p_id returning * into v_row;
  return v_row;
end; $$;
grant execute on function agency_ops.manager_attention_alert_action(uuid,text,text,timestamptz) to authenticated;

create or replace function agency_ops.block_manager_radar_whatsapp_outbox() returns trigger language plpgsql security definer set search_path=pg_catalog,agency_ops,public,extensions as $$ begin if new.category='MANAGER_RADAR' then return null; end if; return new; end; $$;
drop trigger if exists trg_block_manager_radar_whatsapp_outbox on agency_ops.notification_outbox;
create trigger trg_block_manager_radar_whatsapp_outbox before insert on agency_ops.notification_outbox for each row execute function agency_ops.block_manager_radar_whatsapp_outbox();

do $$ begin if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='agency_ops' and tablename='manager_attention_alerts') then alter publication supabase_realtime add table agency_ops.manager_attention_alerts; end if; end $$;