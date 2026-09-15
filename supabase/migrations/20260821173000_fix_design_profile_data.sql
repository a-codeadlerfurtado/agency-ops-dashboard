-- Corrige perfis DESIGN que apareciam zerados apesar de haver atividade no ClickUp.
-- 1) Visao geral especifica de DESIGN fica disponivel.
-- 2) team_overview passa a calcular clientes conforme a funcao.
-- 3) DESIGN usa clientes tocados por tarefas criativas abertas/recentes.
-- 4) Perfil de designer recebe resumo proprio e deterministico.
-- 5) Signup aprovado passa a registrar SUPABASE_AUTH automaticamente.

update agency_ops.dashboard_view_permissions
set allowed=true,
    note='Visão Geral do Designer: produção, prazos, ajustes e entregas',
    updated_at=now()
where view_key='overview' and scope_type='ROLE' and scope_value='DESIGN';

create or replace view agency_ops.team_overview as
with clickup as (
  select a.user_id,min(a.username) username,min(a.email) email,
    count(distinct a.task_id) filter(where t.is_closed) tasks_done,
    count(distinct a.task_id) filter(where not t.is_closed) tasks_open,
    count(distinct a.task_id) filter(where not t.is_closed and t.due_date<now()) tasks_overdue,
    count(distinct a.task_id) filter(where t.is_closed and t.date_closed>now()-interval '30 days') tasks_done_30d,
    count(distinct t.client_id) filter(where t.client_id is not null) clients_touched,
    max(t.date_closed) last_task_done_at
  from agency_ops.clickup_task_assignees a
  join agency_ops.clickup_tasks t on t.task_id=a.task_id
  group by a.user_id
), created as (
  select creator_id,count(*) tasks_created_total,
    count(*) filter(where date_created>now()-interval '30 days') tasks_created_30d
  from agency_ops.clickup_tasks where creator_id is not null group by creator_id
), roster as (
  select distinct on(person) person,role from agency_ops.employee_capacity order by person,date desc
), ident as (
  select lower(person) person_key,person,external_id from agency_ops.team_identities where system='CLICKUP'
), gt_portfolio as (
  select gt_owner person,
    count(*) filter(where lifecycle in('ACTIVE','ONBOARDING')) clients_active,
    count(*) filter(where lifecycle='ONBOARDING') clients_onboarding,
    count(*) filter(where lifecycle in('ACTIVE','ONBOARDING') and priority='ATTENTION') clients_attention,
    count(*) filter(where lifecycle in('ACTIVE','ONBOARDING') and priority='FOLLOW_UP') clients_follow_up
  from agency_ops.dashboard_client_overview where gt_owner is not null group by gt_owner
), cs_portfolio as (
  select cs_owner person,
    count(*) filter(where lifecycle in('ACTIVE','ONBOARDING')) clients_active,
    count(*) filter(where lifecycle='ONBOARDING') clients_onboarding,
    count(*) filter(where lifecycle in('ACTIVE','ONBOARDING') and priority='ATTENTION') clients_attention,
    count(*) filter(where lifecycle in('ACTIVE','ONBOARDING') and priority='FOLLOW_UP') clients_follow_up
  from agency_ops.dashboard_client_overview where cs_owner is not null group by cs_owner
), design_client_links as (
  select distinct i.person,t.client_id
  from ident i
  join agency_ops.clickup_task_assignees a on a.user_id=i.external_id
  join agency_ops.clickup_tasks t on t.task_id=a.task_id
  where t.client_id is not null
    and (not t.is_closed or t.date_closed>=now()-interval '30 days')
    and lower(coalesce(t.list_name,'')||' '||coalesce(t.name,'')) ~ '(criativ|design|arte|video|vídeo|imagem|copy|roteiro|edicao|edição|revisao|revisão|ajuste na campanha|carrossel|feed|story|thumb|banner|logo)'
), design_portfolio as (
  select d.person,
    count(*) filter(where c.lifecycle in('ACTIVE','ONBOARDING')) clients_active,
    count(*) filter(where c.lifecycle='ONBOARDING') clients_onboarding,
    count(*) filter(where c.lifecycle in('ACTIVE','ONBOARDING') and c.priority='ATTENTION') clients_attention,
    count(*) filter(where c.lifecycle in('ACTIVE','ONBOARDING') and c.priority='FOLLOW_UP') clients_follow_up
  from design_client_links d join agency_ops.dashboard_client_overview c on c.client_id=d.client_id
  group by d.person
), role_portfolio as (
  select 'GT'::text role,* from gt_portfolio
  union all select 'CS'::text role,* from cs_portfolio
  union all select 'DESIGN'::text role,* from design_portfolio
), former as (
  select person,clickup_user,left_at,reason from agency_ops.team_former_members
), linked as (
  select r.person,r.role,c.username clickup_user,c.email clickup_email,
    c.tasks_done,c.tasks_open,c.tasks_overdue,c.tasks_done_30d,c.clients_touched,c.last_task_done_at,
    cr.tasks_created_total,cr.tasks_created_30d
  from roster r left join ident i on i.person_key=lower(r.person)
  left join clickup c on c.user_id=i.external_id
  left join created cr on cr.creator_id=i.external_id
)
select l.person,l.role,true in_roster,l.clickup_user,l.clickup_email,
  coalesce(p.clients_active,0)::bigint clients_active,
  coalesce(p.clients_onboarding,0)::bigint clients_onboarding,
  coalesce(p.clients_attention,0)::bigint clients_attention,
  coalesce(p.clients_follow_up,0)::bigint clients_follow_up,
  coalesce(l.tasks_done,0)::bigint tasks_done,coalesce(l.tasks_open,0)::bigint tasks_open,
  coalesce(l.tasks_overdue,0)::bigint tasks_overdue,coalesce(l.tasks_done_30d,0)::bigint tasks_done_30d,
  coalesce(l.clients_touched,0)::bigint clients_touched,l.last_task_done_at,
  (l.clickup_user is null) missing_clickup_link,
  case l.role when 'GT' then 1 when 'CS' then 2 when 'DESIGN' then 3 when 'MGMT' then 4 else 5 end role_order,
  (f.person is not null) is_former,f.left_at former_left_at,f.reason former_reason,
  coalesce(l.tasks_created_total,0)::bigint tasks_created_total,
  coalesce(l.tasks_created_30d,0)::bigint tasks_created_30d
from linked l left join role_portfolio p on p.role=l.role and p.person=l.person
left join former f on lower(f.person)=lower(l.person)
union all
select c.username,case when f.person is not null then 'FORMER' else 'UNASSIGNED' end,false,c.username,c.email,
  0::bigint,0::bigint,0::bigint,0::bigint,
  coalesce(c.tasks_done,0)::bigint,coalesce(c.tasks_open,0)::bigint,coalesce(c.tasks_overdue,0)::bigint,
  coalesce(c.tasks_done_30d,0)::bigint,coalesce(c.clients_touched,0)::bigint,c.last_task_done_at,false,
  case when f.person is not null then 10 else 9 end,(f.person is not null),f.left_at,f.reason,
  coalesce(cr.tasks_created_total,0)::bigint,coalesce(cr.tasks_created_30d,0)::bigint
from clickup c left join created cr on cr.creator_id=c.user_id
left join former f on lower(f.person)=lower(c.username) or lower(f.clickup_user)=lower(c.username)
where not exists(select 1 from ident where ident.external_id=c.user_id);

create or replace view agency_ops.designer_profile_overview as
with ident as (
  select person,external_id clickup_user_id from agency_ops.team_identities where system='CLICKUP'
), creative_tasks as (
  select i.person,i.clickup_user_id,t.task_id,t.client_id,t.name,t.status,t.list_name,t.is_closed,t.due_date,t.date_closed
  from ident i join agency_ops.clickup_task_assignees a on a.user_id=i.clickup_user_id
  join agency_ops.clickup_tasks t on t.task_id=a.task_id
  join agency_ops.team_roster r on r.person=i.person and r.role='DESIGN' and not r.is_former
  where lower(coalesce(t.list_name,'')||' '||coalesce(t.name,'')) ~ '(criativ|design|arte|video|vídeo|imagem|copy|roteiro|edicao|edição|revisao|revisão|ajuste na campanha|carrossel|feed|story|thumb|banner|logo)'
), agg as (
  select person,clickup_user_id,
    count(distinct task_id) filter(where not is_closed) open_creative,
    count(distinct task_id) filter(where not is_closed and (due_date at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date) due_today,
    count(distinct task_id) filter(where not is_closed and due_date<now()) overdue,
    count(distinct task_id) filter(where not is_closed and lower(coalesce(status,'')) ~ '(ajust|revis|andamento|progress|doing|produc|editando|feedback|aprovacao|aprovação)') in_progress,
    count(distinct task_id) filter(where not is_closed and lower(coalesce(status,'')||' '||coalesce(name,'')) ~ '(ajust|revis)') adjustments_reviews,
    count(distinct task_id) filter(where is_closed and date_closed is not null and (date_closed at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date) done_today,
    count(distinct task_id) filter(where is_closed and date_closed>=now()-interval '30 days') done_30d,
    count(distinct client_id) filter(where client_id is not null and (not is_closed or date_closed>=now()-interval '30 days')) clients_touched_30d_or_open,
    max(date_closed) last_done_at
  from creative_tasks group by person,clickup_user_id
), active_clients as (
  select ct.person,count(distinct ct.client_id) active_clients_touched
  from creative_tasks ct join agency_ops.clients c on c.id=ct.client_id
  where c.lifecycle in('ACTIVE','ONBOARDING') and (not ct.is_closed or ct.date_closed>=now()-interval '30 days')
  group by ct.person
)
select a.*,coalesce(ac.active_clients_touched,0)::bigint active_clients_touched,now() generated_at
from agg a left join active_clients ac on ac.person=a.person;

create or replace function agency_ops.sync_approved_signup_auth_identity()
returns trigger language plpgsql security definer
set search_path to 'agency_ops','pg_catalog' as $$
begin
  if new.kind='SIGNUP' and new.status='APPROVED' and nullif(btrim(coalesce(new.user_key,'')),'') is not null and nullif(btrim(coalesce(new.person,'')),'') is not null then
    insert into agency_ops.team_identities(person,system,external_id,external_name,verified,matched_by,metadata)
    values(new.person,'SUPABASE_AUTH',new.user_key,new.person,true,'approved_signup',jsonb_build_object('access_request_id',new.id,'approved_at',coalesce(new.decided_at,now())))
    on conflict(system,external_id) do update set person=excluded.person,external_name=excluded.external_name,verified=true,matched_by=excluded.matched_by,metadata=agency_ops.team_identities.metadata||excluded.metadata,updated_at=now();
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_approved_signup_auth_identity on agency_ops.access_requests;
create trigger trg_sync_approved_signup_auth_identity
after insert or update of status,kind,user_key,person on agency_ops.access_requests
for each row execute function agency_ops.sync_approved_signup_auth_identity();
