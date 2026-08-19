create table if not exists agency_ops.platform_notifications (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  type text not null,
  level text not null check (level in ('CRITICAL','ATTENTION','INFO','SUCCESS','SPECIAL')),
  title text not null,
  description text,
  client_id uuid references agency_ops.clients(id) on delete set null,
  task_id text,
  source text not null,
  actor text,
  occurred_at timestamptz not null default now(),
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists agency_ops.user_preferences (
  user_key text primary key,
  name text not null,
  role text not null,
  email text,
  photo_url text,
  theme text not null default 'dark',
  sounds_enabled boolean not null default true,
  win_sound_enabled boolean not null default true,
  win_celebration_enabled boolean not null default true,
  notifications_enabled boolean not null default true,
  animations_enabled boolean not null default true,
  interface_density text not null default 'comfortable',
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into agency_ops.user_preferences (user_key,name,role)
values ('adler-furtado','Adler Furtado','Gerente Operacional')
on conflict (user_key) do nothing;

create table if not exists agency_ops.client_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  source text not null,
  actor text,
  before_value jsonb,
  after_value jsonb,
  detail text,
  created_at timestamptz not null default now()
);

create table if not exists agency_ops.client_won_events (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  client_id uuid references agency_ops.clients(id) on delete set null,
  occurred_at timestamptz not null,
  initial_source text not null,
  crm_lead_id uuid,
  whatsapp_chat_id text,
  confidence text not null check (confidence in ('CONFIRMED','HIGH','INDICATION')),
  celebration_dispatched boolean not null default false,
  celebrated_at timestamptz,
  evidence jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists platform_notifications_unread_idx on agency_ops.platform_notifications (occurred_at desc) where read_at is null;
create index if not exists platform_notifications_client_idx on agency_ops.platform_notifications (client_id, occurred_at desc);
create index if not exists client_lifecycle_events_client_idx on agency_ops.client_lifecycle_events (client_id, occurred_at desc);
create index if not exists client_won_events_client_idx on agency_ops.client_won_events (client_id, occurred_at desc);

create or replace function agency_ops.record_clickup_completion_notification()
returns trigger language plpgsql security definer set search_path = agency_ops, public as $$
declare v_actor text;
begin
  if new.is_closed and (tg_op = 'INSERT' or not coalesce(old.is_closed,false)) then
    select string_agg(coalesce(a.username,a.email,a.user_id), ', ' order by coalesce(a.username,a.email,a.user_id))
      into v_actor from agency_ops.clickup_task_assignees a where a.task_id=new.task_id;
    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,metadata)
    values ('clickup:closed:'||new.task_id||':'||coalesce(new.date_closed::text,new.last_synced_at::text),
      'TASK_COMPLETED','SUCCESS','Tarefa concluída',new.name,new.client_id,new.task_id,'ClickUp',v_actor,
      coalesce(new.date_closed,new.last_synced_at,now()),jsonb_build_object('url',new.url,'status',new.status,'list',new.list_name))
    on conflict (event_key) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists clickup_completion_notification on agency_ops.clickup_tasks;
create trigger clickup_completion_notification after insert or update of is_closed,date_closed
on agency_ops.clickup_tasks for each row execute function agency_ops.record_clickup_completion_notification();

create or replace function agency_ops.record_client_lifecycle_change()
returns trigger language plpgsql security definer set search_path = agency_ops, public as $$
declare v_at timestamptz := now();
begin
  if new.lifecycle is distinct from old.lifecycle then
    if new.lifecycle in ('CHURNED','PRE_OPS_CHURN') and new.saida is null then new.saida := current_date; end if;
    insert into agency_ops.client_lifecycle_events(event_key,client_id,event_type,occurred_at,source,actor,before_value,after_value,detail)
    values ('client:lifecycle:'||new.id||':'||extract(epoch from v_at)::bigint,new.id,
      case when new.lifecycle in ('CHURNED','PRE_OPS_CHURN') then 'CLIENT_CHURNED' when old.lifecycle in ('CHURNED','PRE_OPS_CHURN') then 'CLIENT_REACTIVATED' else 'LIFECYCLE_CHANGED' end,
      v_at,coalesce(new.source,'Supabase'),'Sistema',jsonb_build_object('lifecycle',old.lifecycle,'saida',old.saida),jsonb_build_object('lifecycle',new.lifecycle,'saida',new.saida),
      'Status alterado de '||old.lifecycle||' para '||new.lifecycle);
  end if;
  return new;
end $$;

drop trigger if exists clients_lifecycle_history on agency_ops.clients;
create trigger clients_lifecycle_history before update of lifecycle on agency_ops.clients
for each row execute function agency_ops.record_client_lifecycle_change();

create or replace function agency_ops.close_onboarding_after_churn()
returns trigger language plpgsql security definer set search_path = agency_ops, public as $$
begin
  if new.lifecycle in ('CHURNED','PRE_OPS_CHURN') and old.lifecycle is distinct from new.lifecycle then
    update agency_ops.onboarding_cases set status='CLOSED',closed_at=coalesce(new.saida::timestamptz,now()),
      metadata=metadata||jsonb_build_object('closed_reason','CLIENT_CHURNED','closed_automatically',true),updated_at=now()
    where client_id=new.id and status='OPEN';
  end if;
  return new;
end $$;

drop trigger if exists clients_close_onboarding_after_churn on agency_ops.clients;
create trigger clients_close_onboarding_after_churn after update of lifecycle on agency_ops.clients
for each row execute function agency_ops.close_onboarding_after_churn();

create or replace function agency_ops.capture_crm_client_won()
returns trigger language plpgsql security definer set search_path = agency_ops, crm, public as $$
declare v_client uuid; v_name text; v_when timestamptz;
begin
  if lower(coalesce(new.stage,''))='fechado' and (tg_op='INSERT' or lower(coalesce(old.stage,''))<>'fechado') then
    v_name := coalesce(nullif(new.company,''),new.name);
    v_when := coalesce(new.closed_at,new.updated_at,now());
    select c.id into v_client from agency_ops.clients c
      where c.crm_lead_id=new.id or c.normalized_name=agency_ops.normalize_name(v_name)
      order by (c.crm_lead_id=new.id) desc limit 1;
    insert into agency_ops.client_won_events(dedupe_key,client_id,occurred_at,initial_source,crm_lead_id,confidence,evidence)
    values ('crm:'||new.id,v_client,v_when,'CRM Comercial',new.id,'CONFIRMED',jsonb_build_array(jsonb_build_object('source','CRM Comercial','stage',new.stage,'at',v_when)))
    on conflict (dedupe_key) do update set client_id=coalesce(excluded.client_id,agency_ops.client_won_events.client_id),updated_at=now();
    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,occurred_at,metadata)
    values ('client-won:crm:'||new.id,'CLIENT_WON','SPECIAL','Novo cliente',v_name,v_client,'CRM Comercial',v_when,jsonb_build_object('crm_lead_id',new.id))
    on conflict (event_key) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists crm_capture_client_won on crm.leads;
create trigger crm_capture_client_won after insert or update of stage on crm.leads
for each row execute function agency_ops.capture_crm_client_won();

create or replace view agency_ops.crm_preclients as
select l.id,l.name,l.company,l.owner_id,l.stage,l.estimated_value,l.source,l.created_at,l.updated_at,
       l.closed_at,
       extract(epoch from (now()-l.updated_at))/86400.0 as days_in_stage,
       (select max(a.created_at) from crm.lead_activities a where a.lead_id=l.id) as last_interaction,
       (select min(a.due_at) from crm.lead_activities a where a.lead_id=l.id and not a.done and a.due_at is not null) as next_action_at,
       (select a.content from crm.lead_activities a where a.lead_id=l.id and not a.done order by a.due_at nulls last,a.created_at desc limit 1) as next_action
from crm.leads l
where l.archived_at is null and lower(coalesce(l.stage,'')) in ('proposta','negociacao','pre-assinatura','pré-assinatura','contrato enviado','assinatura');

drop view if exists agency_ops.dashboard_client_overview;
create view agency_ops.dashboard_client_overview as
select c.id as client_id,c.display_name,c.lifecycle,c.entrada,c.saida,c.cs_owner,c.gt_owner,c.designer_owner,
  case when c.entrada is null then null when c.lifecycle in ('CHURNED','PRE_OPS_CHURN') and c.saida is not null then c.saida-c.entrada else current_date-c.entrada end as client_days,
  s.priority,s.waiting_direction,s.summary_today,s.current_subject,s.action_owner,s.next_step,s.next_step_due,
  s.open_commitments,s.overdue_commitments,s.open_complaints,s.pending_approvals,s.blockers,s.data_coverage,s.confidence,s.last_activity_at,s.snapshot_at,
  oc.status as onboarding_status,oc.current_stage as onboarding_stage,oc.onboarding_risk,oc.blocked_by as onboarding_blocked_by,oc.next_action as onboarding_next_action,
  nb.notion_page_id as briefing_page_id,nb.page_url as briefing_url,nb.sync_status as briefing_sync_status,nb.extracted_profile as briefing_profile,
  (select count(*) from agency_ops.media_metrics_daily m where m.client_id=c.id and m.date=(select max(m2.date) from agency_ops.media_metrics_daily m2 where m2.client_id=c.id)) as campaigns,
  (select count(*) from agency_ops.operational_alerts a where a.client_id=c.id and a.status='OPEN') as alerts_count
from agency_ops.clients c
left join agency_ops.client_operational_snapshot s on s.client_id=c.id
left join lateral (select * from agency_ops.onboarding_cases o where o.client_id=c.id order by o.updated_at desc,o.id desc limit 1) oc on true
left join lateral (select * from agency_ops.notion_briefing_pages b where b.client_id=c.id and b.match_status='CONFIRMED' order by b.updated_at desc limit 1) nb on true;

grant select on agency_ops.crm_preclients to service_role;
grant select on agency_ops.dashboard_client_overview to service_role;

alter table agency_ops.platform_notifications enable row level security;
alter table agency_ops.user_preferences enable row level security;
alter table agency_ops.client_lifecycle_events enable row level security;
alter table agency_ops.client_won_events enable row level security;
revoke all on agency_ops.platform_notifications,agency_ops.user_preferences,agency_ops.client_lifecycle_events,agency_ops.client_won_events from anon,authenticated;
grant all on agency_ops.platform_notifications,agency_ops.user_preferences,agency_ops.client_lifecycle_events,agency_ops.client_won_events to service_role;

do $$ begin
  alter publication supabase_realtime add table agency_ops.platform_notifications;
exception when duplicate_object then null; end $$;
