-- Views do quadro de equipe. Ver 20260819200000 para o registro de identidades.
--
-- team_overview: quadro de pessoal (employee_capacity) cruzado com produtividade do
-- ClickUp e carteira por gt_owner. O cruzamento com ClickUp usa o user_id registrado
-- em team_identities, nao o nome - match por nome quebrava com "joel antoniete" e
-- "Davi Henrique Florencio de Andrade", e com qualquer troca de nome no ClickUp.
create or replace view agency_ops.team_overview as
with clickup as (
  select a.user_id,
         min(a.username) as username,
         min(a.email)    as email,
         count(distinct a.task_id) filter (where t.is_closed)                            as tasks_done,
         count(distinct a.task_id) filter (where not t.is_closed)                        as tasks_open,
         count(distinct a.task_id) filter (where not t.is_closed and t.due_date < now()) as tasks_overdue,
         count(distinct a.task_id) filter (where t.is_closed
               and t.date_closed > now() - interval '30 days')                           as tasks_done_30d,
         count(distinct t.client_id) filter (where t.client_id is not null)              as clients_touched,
         max(t.date_closed)                                                              as last_task_done_at
  from agency_ops.clickup_task_assignees a
  join agency_ops.clickup_tasks t on t.task_id = a.task_id
  group by a.user_id
),
roster as (
  select distinct on (person) person, role from agency_ops.employee_capacity order by person, date desc
),
portfolio as (
  select gt_owner,
         count(*) filter (where lifecycle in ('ACTIVE','ONBOARDING')) as clients_active,
         count(*) filter (where lifecycle = 'ONBOARDING')             as clients_onboarding,
         count(*) filter (where priority = 'ATTENTION')               as clients_attention,
         count(*) filter (where priority = 'FOLLOW_UP')               as clients_follow_up
  from agency_ops.dashboard_client_overview where gt_owner is not null group by gt_owner
),
former as (select person, clickup_user, left_at, reason from agency_ops.team_former_members),
ident as (select lower(person) as person_key, external_id from agency_ops.team_identities where system = 'CLICKUP'),
linked as (
  select r.person, r.role, c.username as clickup_user, c.email as clickup_email,
         c.tasks_done, c.tasks_open, c.tasks_overdue, c.tasks_done_30d,
         c.clients_touched, c.last_task_done_at
  from roster r
  left join ident    on ident.person_key = lower(r.person)
  left join clickup c on c.user_id = ident.external_id
)
select l.person, l.role, true as in_roster, l.clickup_user, l.clickup_email,
       coalesce(p.clients_active,0), coalesce(p.clients_onboarding,0),
       coalesce(p.clients_attention,0), coalesce(p.clients_follow_up,0),
       coalesce(l.tasks_done,0), coalesce(l.tasks_open,0), coalesce(l.tasks_overdue,0),
       coalesce(l.tasks_done_30d,0), coalesce(l.clients_touched,0), l.last_task_done_at,
       (l.clickup_user is null) as missing_clickup_link,
       case l.role when 'GT' then 1 when 'CS' then 2 when 'DESIGN' then 3 when 'MGMT' then 4 else 5 end as role_order,
       (f.person is not null) as is_former, f.left_at as former_left_at, f.reason as former_reason
from linked l
left join portfolio p on p.gt_owner = l.person
left join former f on lower(f.person) = lower(l.person)
union all
select c.username, case when f.person is not null then 'FORMER' else 'UNASSIGNED' end, false,
       c.username, c.email, 0,0,0,0,
       c.tasks_done, c.tasks_open, c.tasks_overdue, c.tasks_done_30d,
       c.clients_touched, c.last_task_done_at, false,
       case when f.person is not null then 10 else 9 end,
       (f.person is not null), f.left_at, f.reason
from clickup c
left join former f on lower(f.person) = lower(c.username) or lower(f.clickup_user) = lower(c.username)
where not exists (select 1 from ident where ident.external_id = c.user_id);

-- Uma linha por colaborador com o id de cada sistema lado a lado, mais o que falta.
create or replace view agency_ops.team_identity_map as
select t.person, t.role, r.access_level,
  max(i.external_id)   filter (where i.system='EMAIL')          as email,
  max(i.external_id)   filter (where i.system='CLICKUP')        as clickup_user_id,
  max(i.external_name) filter (where i.system='CLICKUP')        as clickup_username,
  max(i.external_id)   filter (where i.system='WHATSAPP_PHONE') as whatsapp_phone,
  count(*)             filter (where i.system='WHATSAPP_NAME')  as whatsapp_aliases,
  max(i.external_id)   filter (where i.system='SUPABASE_AUTH')  as auth_user_id,
  max(i.external_id)   filter (where i.system='META')           as meta_user_id,
  max(i.external_id)   filter (where i.system='NOTION')         as notion_user_id,
  array_remove(array[
    case when count(*) filter (where i.system='EMAIL')          = 0 then 'EMAIL'          end,
    case when count(*) filter (where i.system='CLICKUP')        = 0 then 'CLICKUP'        end,
    case when count(*) filter (where i.system='WHATSAPP_PHONE') = 0 then 'WHATSAPP_PHONE' end,
    case when count(*) filter (where i.system='SUPABASE_AUTH')  = 0 then 'SUPABASE_AUTH'  end,
    case when count(*) filter (where i.system='META')           = 0 then 'META'           end
  ], null) as faltando,
  round(100.0 * (
    (case when count(*) filter (where i.system='EMAIL')          > 0 then 1 else 0 end) +
    (case when count(*) filter (where i.system='CLICKUP')        > 0 then 1 else 0 end) +
    (case when count(*) filter (where i.system='WHATSAPP_PHONE') > 0 then 1 else 0 end) +
    (case when count(*) filter (where i.system='SUPABASE_AUTH')  > 0 then 1 else 0 end) +
    (case when count(*) filter (where i.system='META')           > 0 then 1 else 0 end)
  ) / 5.0, 0) as sincronizado_pct,
  t.role_order
from agency_ops.team_overview t
left join agency_ops.team_identities i on lower(i.person) = lower(t.person)
left join agency_ops.team_roster r     on lower(r.person) = lower(t.person)
where t.in_roster
group by t.person, t.role, r.access_level, t.role_order;
