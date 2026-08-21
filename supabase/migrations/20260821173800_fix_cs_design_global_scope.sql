-- Regra operacional:
--   GT possui carteira propria e e filtrado por gt_owner.
--   CS e DESIGN atendem a base completa das carteiras; nunca devem ser filtrados
--   por cs_owner/designer_owner como se esses campos representassem carteira.

create or replace view agency_ops.team_overview as
with clickup as (
  select a.user_id,
         min(a.username) as username,
         min(a.email) as email,
         count(distinct a.task_id) filter (where t.is_closed) as tasks_done,
         count(distinct a.task_id) filter (where not t.is_closed) as tasks_open,
         count(distinct a.task_id) filter (where not t.is_closed and t.due_date < now()) as tasks_overdue,
         count(distinct a.task_id) filter (where t.is_closed and t.date_closed > now() - interval '30 days') as tasks_done_30d,
         count(distinct t.client_id) filter (where t.client_id is not null) as clients_touched,
         max(t.date_closed) as last_task_done_at
  from agency_ops.clickup_task_assignees a
  join agency_ops.clickup_tasks t on t.task_id = a.task_id
  group by a.user_id
),
created as (
  select t.creator_id,
         count(*) as tasks_created_total,
         count(*) filter (where t.date_created > now() - interval '30 days') as tasks_created_30d
  from agency_ops.clickup_tasks t
  where t.creator_id is not null
  group by t.creator_id
),
roster as (
  select distinct on (ec.person) ec.person, ec.role
  from agency_ops.employee_capacity ec
  order by ec.person, ec.date desc
),
gt_portfolio as (
  select d.gt_owner,
         count(*) filter (where d.lifecycle in ('ACTIVE','ONBOARDING')) as clients_active,
         count(*) filter (where d.lifecycle = 'ONBOARDING') as clients_onboarding,
         count(*) filter (where d.lifecycle in ('ACTIVE','ONBOARDING') and d.priority = 'ATTENTION') as clients_attention,
         count(*) filter (where d.lifecycle in ('ACTIVE','ONBOARDING') and d.priority = 'FOLLOW_UP') as clients_follow_up
  from agency_ops.dashboard_client_overview d
  where d.gt_owner is not null
  group by d.gt_owner
),
base_totals as (
  select count(*) filter (where lifecycle in ('ACTIVE','ONBOARDING')) as clients_active,
         count(*) filter (where lifecycle = 'ONBOARDING') as clients_onboarding,
         count(*) filter (where lifecycle in ('ACTIVE','ONBOARDING') and priority = 'ATTENTION') as clients_attention,
         count(*) filter (where lifecycle in ('ACTIVE','ONBOARDING') and priority = 'FOLLOW_UP') as clients_follow_up
  from agency_ops.dashboard_client_overview
),
former as (
  select person, clickup_user, left_at, reason
  from agency_ops.team_former_members
),
ident as (
  select lower(person) as person_key, external_id
  from agency_ops.team_identities
  where system = 'CLICKUP'
),
linked as (
  select r.person, r.role,
         c.username as clickup_user,
         c.email as clickup_email,
         c.tasks_done, c.tasks_open, c.tasks_overdue, c.tasks_done_30d,
         c.clients_touched, c.last_task_done_at,
         cr.tasks_created_total, cr.tasks_created_30d
  from roster r
  left join ident i on i.person_key = lower(r.person)
  left join clickup c on c.user_id = i.external_id
  left join created cr on cr.creator_id = i.external_id
)
select l.person,
       l.role,
       true as in_roster,
       l.clickup_user,
       l.clickup_email,
       case when l.role = 'GT' then coalesce(p.clients_active,0) when l.role in ('CS','DESIGN') then coalesce(b.clients_active,0) else 0 end as clients_active,
       case when l.role = 'GT' then coalesce(p.clients_onboarding,0) when l.role in ('CS','DESIGN') then coalesce(b.clients_onboarding,0) else 0 end as clients_onboarding,
       case when l.role = 'GT' then coalesce(p.clients_attention,0) when l.role in ('CS','DESIGN') then coalesce(b.clients_attention,0) else 0 end as clients_attention,
       case when l.role = 'GT' then coalesce(p.clients_follow_up,0) when l.role in ('CS','DESIGN') then coalesce(b.clients_follow_up,0) else 0 end as clients_follow_up,
       coalesce(l.tasks_done,0) as tasks_done,
       coalesce(l.tasks_open,0) as tasks_open,
       coalesce(l.tasks_overdue,0) as tasks_overdue,
       coalesce(l.tasks_done_30d,0) as tasks_done_30d,
       coalesce(l.clients_touched,0) as clients_touched,
       l.last_task_done_at,
       l.clickup_user is null as missing_clickup_link,
       case l.role when 'GT' then 1 when 'CS' then 2 when 'DESIGN' then 3 when 'MGMT' then 4 else 5 end as role_order,
       f.person is not null as is_former,
       f.left_at as former_left_at,
       f.reason as former_reason,
       coalesce(l.tasks_created_total,0) as tasks_created_total,
       coalesce(l.tasks_created_30d,0) as tasks_created_30d
from linked l
left join gt_portfolio p on p.gt_owner = l.person
cross join base_totals b
left join former f on lower(f.person) = lower(l.person)
union all
select c.username as person,
       case when f.person is not null then 'FORMER' else 'UNASSIGNED' end as role,
       false as in_roster,
       c.username as clickup_user,
       c.email as clickup_email,
       0 as clients_active, 0 as clients_onboarding, 0 as clients_attention, 0 as clients_follow_up,
       c.tasks_done, c.tasks_open, c.tasks_overdue, c.tasks_done_30d, c.clients_touched, c.last_task_done_at,
       false as missing_clickup_link,
       case when f.person is not null then 10 else 9 end as role_order,
       f.person is not null as is_former,
       f.left_at as former_left_at,
       f.reason as former_reason,
       coalesce(cr.tasks_created_total,0) as tasks_created_total,
       coalesce(cr.tasks_created_30d,0) as tasks_created_30d
from clickup c
left join created cr on cr.creator_id = c.user_id
left join former f on lower(f.person) = lower(c.username) or lower(f.clickup_user) = lower(c.username)
where not exists (select 1 from ident where ident.external_id = c.user_id);

comment on view agency_ops.team_overview is
'GT tem carteira propria; CS e DESIGN atendem a base completa das carteiras. clients_* para CS/DESIGN representam a base operacional total, nunca carteira individual.';
