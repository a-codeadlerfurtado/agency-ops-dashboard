-- Closer Cockpit v2: canonical sale linkage, safe CRM reconciliation and post-call follow-up.
create table if not exists agency_ops.commercial_client_lead_links (
  client_id uuid primary key references agency_ops.clients(id) on delete cascade,
  lead_id uuid not null,
  closer_person text,
  link_source text not null default 'CLIENT_CRM_LEAD_ID',
  confidence numeric(5,4) not null default 1.0000 check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '{}'::jsonb,
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists commercial_client_lead_links_lead_uidx on agency_ops.commercial_client_lead_links(lead_id);
alter table agency_ops.commercial_client_lead_links enable row level security;
revoke all on agency_ops.commercial_client_lead_links from anon, authenticated;

alter table agency_ops.commercial_prospect_profiles
  add column if not exists loss_reason text,
  add column if not exists cadence_status text not null default 'ACTIVE';

create or replace function agency_ops.sync_client_crm_win()
returns trigger language plpgsql security definer
set search_path to 'agency_ops','crm','public','pg_catalog'
as $$
declare v_closed_at timestamptz;
begin
  if new.crm_lead_id is null or coalesce(new.closer_origin,'')='' or new.lifecycle not in ('ACTIVE','ONBOARDING','CHURNED') then return new; end if;
  v_closed_at := coalesce(case when new.entrada is not null then (new.entrada::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo' else null end,now());
  insert into agency_ops.commercial_client_lead_links(client_id,lead_id,closer_person,link_source,confidence,evidence,confirmed_at,updated_at)
  values(new.id,new.crm_lead_id,new.closer_origin,'CLIENT_CRM_LEAD_ID',1.0000,jsonb_build_object('client_display_name',new.display_name,'client_lifecycle',new.lifecycle,'client_entrada',new.entrada),now(),now())
  on conflict(client_id) do update set lead_id=excluded.lead_id,closer_person=excluded.closer_person,link_source=excluded.link_source,confidence=excluded.confidence,evidence=excluded.evidence,confirmed_at=now(),updated_at=now();
  update crm.leads set stage='fechado',closed_at=coalesce(closed_at,v_closed_at),updated_at=now()
   where id=new.crm_lead_id and closed_monthly_value is not null and closed_setup_value is not null
     and closed_term_months is not null and closed_term_months>0
     and nullif(trim(coalesce(closed_setup_payment,'')),'') is not null
     and (stage is distinct from 'fechado' or closed_at is null);
  return new;
end $$;

drop trigger if exists trg_clients_sync_crm_win on agency_ops.clients;
create trigger trg_clients_sync_crm_win after insert or update of crm_lead_id,lifecycle,closer_origin,entrada
on agency_ops.clients for each row execute function agency_ops.sync_client_crm_win();

insert into agency_ops.commercial_client_lead_links(client_id,lead_id,closer_person,link_source,confidence,evidence,confirmed_at,updated_at)
select c.id,c.crm_lead_id,c.closer_origin,'CLIENT_CRM_LEAD_ID',1.0000,
       jsonb_build_object('client_display_name',c.display_name,'client_lifecycle',c.lifecycle,'client_entrada',c.entrada),now(),now()
from agency_ops.clients c
where c.crm_lead_id is not null and coalesce(c.closer_origin,'')<>'' and c.lifecycle in ('ACTIVE','ONBOARDING','CHURNED')
on conflict(client_id) do update set lead_id=excluded.lead_id,closer_person=excluded.closer_person,link_source=excluded.link_source,confidence=excluded.confidence,evidence=excluded.evidence,confirmed_at=now(),updated_at=now();

update crm.leads l
set stage='fechado',
    closed_at=coalesce(l.closed_at,(c.entrada::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo',now()),
    updated_at=now()
from agency_ops.clients c
where c.crm_lead_id=l.id and coalesce(c.closer_origin,'')<>'' and c.lifecycle in ('ACTIVE','ONBOARDING','CHURNED')
  and l.closed_monthly_value is not null and l.closed_setup_value is not null
  and l.closed_term_months is not null and l.closed_term_months>0
  and nullif(trim(coalesce(l.closed_setup_payment,'')),'') is not null
  and (l.stage is distinct from 'fechado' or l.closed_at is null);

create or replace function agency_ops.sync_commercial_call_to_prospect()
returns trigger language plpgsql security definer
set search_path to 'agency_ops','public','pg_catalog'
as $$
declare v_summary text;
begin
  if new.lead_id is null then return new; end if;
  v_summary := coalesce(nullif(new.closer_briefing,''),nullif(new.ai_summary,''),nullif(new.notes,''));
  insert into agency_ops.commercial_prospect_profiles(
    lead_id,sdr_person,closer_person,last_call_at,last_transcript_id,primary_pain,secondary_pains,pain_points,goals,objections,
    urgency,decision_role,current_structure,services_interest,buying_signals,closing_risks,closer_briefing,qualification_summary,next_step,next_step_at,updated_at
  ) values (
    new.lead_id,new.sdr_person,new.closer_person,coalesce(new.created_at,now()),new.transcript_id,nullif(new.primary_pain,''),
    coalesce(new.secondary_pains,'{}'::text[]),coalesce(new.pain_points,'{}'::text[]),coalesce(new.goals,'{}'::text[]),coalesce(new.objections,'{}'::text[]),
    nullif(new.urgency,''),nullif(new.decision_role,''),nullif(new.current_structure,''),coalesce(new.services_interest,'{}'::text[]),
    coalesce(new.buying_signals,'{}'::text[]),coalesce(new.closing_risks,'{}'::text[]),nullif(new.closer_briefing,''),v_summary,nullif(new.next_step,''),new.next_step_at,now()
  )
  on conflict(lead_id) do update set
    sdr_person=coalesce(nullif(excluded.sdr_person,''),commercial_prospect_profiles.sdr_person),
    closer_person=coalesce(nullif(excluded.closer_person,''),commercial_prospect_profiles.closer_person),
    last_call_at=greatest(coalesce(commercial_prospect_profiles.last_call_at,'epoch'::timestamptz),excluded.last_call_at),
    last_transcript_id=coalesce(excluded.last_transcript_id,commercial_prospect_profiles.last_transcript_id),
    primary_pain=coalesce(nullif(excluded.primary_pain,''),commercial_prospect_profiles.primary_pain),
    secondary_pains=case when cardinality(excluded.secondary_pains)>0 then excluded.secondary_pains else commercial_prospect_profiles.secondary_pains end,
    pain_points=case when cardinality(excluded.pain_points)>0 then excluded.pain_points else commercial_prospect_profiles.pain_points end,
    goals=case when cardinality(excluded.goals)>0 then excluded.goals else commercial_prospect_profiles.goals end,
    objections=case when cardinality(excluded.objections)>0 then excluded.objections else commercial_prospect_profiles.objections end,
    urgency=coalesce(nullif(excluded.urgency,''),commercial_prospect_profiles.urgency),
    decision_role=coalesce(nullif(excluded.decision_role,''),commercial_prospect_profiles.decision_role),
    current_structure=coalesce(nullif(excluded.current_structure,''),commercial_prospect_profiles.current_structure),
    services_interest=case when cardinality(excluded.services_interest)>0 then excluded.services_interest else commercial_prospect_profiles.services_interest end,
    buying_signals=case when cardinality(excluded.buying_signals)>0 then excluded.buying_signals else commercial_prospect_profiles.buying_signals end,
    closing_risks=case when cardinality(excluded.closing_risks)>0 then excluded.closing_risks else commercial_prospect_profiles.closing_risks end,
    closer_briefing=coalesce(nullif(excluded.closer_briefing,''),commercial_prospect_profiles.closer_briefing),
    qualification_summary=coalesce(nullif(excluded.qualification_summary,''),commercial_prospect_profiles.qualification_summary),
    next_step=coalesce(nullif(excluded.next_step,''),commercial_prospect_profiles.next_step),
    next_step_at=coalesce(excluded.next_step_at,commercial_prospect_profiles.next_step_at),
    updated_at=now();
  if nullif(new.next_step,'') is not null and not exists(
    select 1 from agency_ops.commercial_activities a where a.lead_id=new.lead_id and a.completed_at is null and a.source='RELATO_AUTO' and a.metadata->>'call_id'=new.id::text
  ) then
    insert into agency_ops.commercial_activities(lead_id,activity_type,title,description,owner_person,due_at,source,metadata)
    values(new.lead_id,'FOLLOW_UP','Próximo passo pós-call',new.next_step,coalesce(nullif(new.closer_person,''),'Comercial'),new.next_step_at,'RELATO_AUTO',
      jsonb_build_object('call_id',new.id,'transcript_id',new.transcript_id,'needs_schedule',new.next_step_at is null));
  end if;
  return new;
end $$;

drop trigger if exists trg_commercial_call_sync_prospect on agency_ops.commercial_call_records;
create trigger trg_commercial_call_sync_prospect
after insert or update of transcript_id,ai_summary,primary_pain,secondary_pains,pain_points,goals,objections,urgency,decision_role,current_structure,services_interest,buying_signals,closing_risks,closer_briefing,next_step,next_step_at,outcome
on agency_ops.commercial_call_records for each row execute function agency_ops.sync_commercial_call_to_prospect();

create index if not exists commercial_activities_lead_open_due_idx on agency_ops.commercial_activities(lead_id,due_at) where completed_at is null;
create index if not exists commercial_call_records_closer_created_idx on agency_ops.commercial_call_records(closer_person,created_at desc);
create index if not exists commercial_prospect_profiles_closer_next_idx on agency_ops.commercial_prospect_profiles(closer_person,next_step_at);
