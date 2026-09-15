create table if not exists agency_ops.onboarding_required_alerts (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  alert_type text not null,
  client_id uuid references agency_ops.clients(id) on delete cascade,
  onboarding_case_id bigint references agency_ops.onboarding_cases(id) on delete cascade,
  target_person text not null,
  target_role text,
  title text not null,
  description text not null,
  actor text,
  occurred_at timestamptz not null default now(),
  ack_required boolean not null default true,
  ack_label text not null default 'Ciente',
  acknowledged_at timestamptz,
  acknowledged_by_user_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists onboarding_required_alerts_target_pending_idx
  on agency_ops.onboarding_required_alerts(target_person, acknowledged_at, occurred_at);
create index if not exists onboarding_required_alerts_client_idx
  on agency_ops.onboarding_required_alerts(client_id, occurred_at desc);

create or replace function agency_ops.enqueue_onboarding_required_alert(
  p_event_key text,
  p_alert_type text,
  p_client_id uuid,
  p_case_id bigint,
  p_target_person text,
  p_target_role text,
  p_title text,
  p_description text,
  p_actor text default null,
  p_ack_label text default 'Ciente',
  p_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer
set search_path to 'agency_ops','public'
as $$
declare v_id uuid;
begin
  if nullif(btrim(p_target_person),'') is null then return null; end if;
  if not exists (select 1 from agency_ops.team_roster tr where tr.person=p_target_person and coalesce(tr.is_former,false)=false) then return null; end if;
  insert into agency_ops.onboarding_required_alerts(event_key,alert_type,client_id,onboarding_case_id,target_person,target_role,title,description,actor,ack_label,metadata)
  values(p_event_key,p_alert_type,p_client_id,p_case_id,p_target_person,p_target_role,p_title,p_description,p_actor,coalesce(nullif(p_ack_label,''),'Ciente'),coalesce(p_metadata,'{}'::jsonb))
  on conflict(event_key) do nothing returning id into v_id;
  return v_id;
end;
$$;

create or replace function agency_ops.maybe_enqueue_onboarding_meeting_handoff(p_case_id bigint,p_target_stage text,p_target_person text,p_trigger_stage text)
returns uuid language plpgsql security definer set search_path to 'agency_ops','public'
as $$
declare
  v_client_id uuid; v_client_name text; v_target_status text; v_target_role text;
  v_title text; v_description text; v_event_key text;
begin
  select oc.client_id,c.display_name,s.status into v_client_id,v_client_name,v_target_status
  from agency_ops.onboarding_cases oc join agency_ops.clients c on c.id=oc.client_id
  join agency_ops.onboarding_stages s on s.case_id=oc.id and s.stage_code=p_target_stage where oc.id=p_case_id;
  if v_client_id is null or v_target_status not in ('PENDING','MENTIONED') or nullif(btrim(p_target_person),'') is null then return null; end if;
  select role into v_target_role from agency_ops.team_roster where person=p_target_person and coalesce(is_former,false)=false limit 1;
  if v_target_role is null then return null; end if;
  if p_target_stage='INTRO_MEETING' then
    v_title:='Próxima etapa de onboarding — '||v_client_name;
    v_description:='O onboarding de '||v_client_name||' está pronto para sua etapa. Marque a 1ª reunião de apresentação com o cliente.';
  elsif p_target_stage='PRODUCT_PERSONA_MEETING' then
    v_title:='Marcar reunião Produto + Persona — '||v_client_name;
    v_description:='A 1ª reunião de apresentação de '||v_client_name||' foi concluída. Agora você precisa marcar a reunião de Produto + Persona com o cliente.';
  elsif p_target_stage='INTEGRATION_MEETING' then
    v_title:='Marcar reunião de integração — '||v_client_name;
    v_description:='A reunião de Produto + Persona de '||v_client_name||' foi concluída. Agora você precisa marcar a reunião de integração com o cliente.';
  else return null; end if;
  v_event_key:='onboarding:handoff:'||p_case_id::text||':'||p_target_stage||':'||p_target_person;
  return agency_ops.enqueue_onboarding_required_alert(v_event_key,'ONBOARDING_MEETING_HANDOFF',v_client_id,p_case_id,p_target_person,v_target_role,v_title,v_description,'onboarding_engine','Ciente, vou resolver',jsonb_build_object('trigger_stage',p_trigger_stage,'target_stage',p_target_stage,'action_type','SCHEDULE_MEETING','decision_mode','HUMAN_ACTION_REQUIRED'));
end;
$$;

create or replace function agency_ops.tg_onboarding_stage_required_handoff()
returns trigger language plpgsql security definer set search_path to 'agency_ops','public'
as $$
declare v_gt text;
begin
  if tg_op<>'UPDATE' or new.status is not distinct from old.status or new.status<>'DONE' then return new; end if;
  if new.stage_code='OPERATIONAL_ACTIVATION' then
    perform agency_ops.maybe_enqueue_onboarding_meeting_handoff(new.case_id,'INTRO_MEETING','Joel Antoniete','OPERATIONAL_ACTIVATION');
  elsif new.stage_code='INTRO_MEETING' then
    perform agency_ops.maybe_enqueue_onboarding_meeting_handoff(new.case_id,'PRODUCT_PERSONA_MEETING','Gustavo Lima','INTRO_MEETING');
  elsif new.stage_code='PRODUCT_PERSONA_MEETING' then
    select c.gt_owner into v_gt from agency_ops.onboarding_cases oc join agency_ops.clients c on c.id=oc.client_id where oc.id=new.case_id;
    if nullif(btrim(v_gt),'') is not null then perform agency_ops.maybe_enqueue_onboarding_meeting_handoff(new.case_id,'INTEGRATION_MEETING',v_gt,'PRODUCT_PERSONA_MEETING'); end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_onboarding_stage_required_handoff on agency_ops.onboarding_stages;
create trigger trg_onboarding_stage_required_handoff after update of status on agency_ops.onboarding_stages
for each row execute function agency_ops.tg_onboarding_stage_required_handoff();

create or replace function agency_ops.tg_onboarding_gt_assignment_required_alerts()
returns trigger language plpgsql security definer set search_path to 'agency_ops','public'
as $$
declare
  v_client_name text; v_case_id bigint; v_recipient text; v_role text; v_description text; v_event_key text; v_product_persona_done boolean:=false;
begin
  if tg_op<>'UPDATE' or new.status<>'ASSIGNED' or old.status='ASSIGNED' or nullif(btrim(new.assigned_gt),'') is null then return new; end if;
  select c.display_name,new.case_id into v_client_name,v_case_id from agency_ops.clients c where c.id=new.client_id;
  for v_recipient in
    select x.person from (values ('Gustavo Lima'::text),('Joel Antoniete'::text),('Adler Furtado'::text),(new.assigned_gt::text)) x(person)
    where x.person is distinct from new.assigned_by group by x.person
  loop
    select role into v_role from agency_ops.team_roster where person=v_recipient and coalesce(is_former,false)=false limit 1;
    if v_role is null then continue; end if;
    if v_recipient=new.assigned_gt then
      v_description:='O cliente '||v_client_name||' foi atribuído a você por '||coalesce(new.assigned_by,'um colaborador da operação')||'. Você passa a ser o GT responsável. Acompanhe o onboarding e as próximas etapas do cliente.';
    else
      v_description:='O cliente '||v_client_name||' foi atribuído ao gestor de tráfego '||new.assigned_gt||' por '||coalesce(new.assigned_by,'um colaborador da operação')||'.';
    end if;
    v_event_key:='onboarding:gt-assigned:'||new.id::text||':'||v_recipient;
    perform agency_ops.enqueue_onboarding_required_alert(v_event_key,'GT_ASSIGNMENT_INFO',new.client_id,v_case_id,v_recipient,v_role,case when v_recipient=new.assigned_gt then 'Novo cliente na sua carteira — '||v_client_name else 'GT definido — '||v_client_name end,v_description,new.assigned_by,'Ciente',jsonb_build_object('assigned_gt',new.assigned_gt,'assigned_by',new.assigned_by,'assigned_carteira',new.assigned_carteira,'assignment_request_id',new.id,'action_type','ACK_ASSIGNMENT'));
  end loop;
  select exists(select 1 from agency_ops.onboarding_stages s where s.case_id=v_case_id and s.stage_code='PRODUCT_PERSONA_MEETING' and s.status='DONE') into v_product_persona_done;
  if v_product_persona_done then perform agency_ops.maybe_enqueue_onboarding_meeting_handoff(v_case_id,'INTEGRATION_MEETING',new.assigned_gt,'GT_ASSIGNMENT_AFTER_PRODUCT_PERSONA'); end if;
  return new;
end;
$$;

drop trigger if exists trg_onboarding_gt_assignment_required_alerts on agency_ops.onboarding_gt_assignment_requests;
create trigger trg_onboarding_gt_assignment_required_alerts after update of status,assigned_gt,assigned_by,assigned_at on agency_ops.onboarding_gt_assignment_requests
for each row execute function agency_ops.tg_onboarding_gt_assignment_required_alerts();
