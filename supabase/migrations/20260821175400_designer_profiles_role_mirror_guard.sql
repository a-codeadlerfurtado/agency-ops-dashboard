-- Perfis DESIGN devem ser espelhos por papel. Individualidade vem dos dados de
-- identidade/tarefas, nunca de permissao PERSON.

delete from agency_ops.dashboard_view_permissions p
where p.scope_type = 'PERSON'
  and exists (
    select 1 from agency_ops.team_roster tr
    where tr.person = p.scope_value
      and tr.role = 'DESIGN'
      and tr.is_former = false
  );

create or replace function agency_ops.dashboard_allowed_views(p_person text, p_role text)
returns text[]
language sql
stable
security definer
set search_path to 'agency_ops','public'
as $function$
  with por_papel as (
    select view_key, allowed
    from agency_ops.dashboard_view_permissions
    where scope_type = 'ROLE' and scope_value = coalesce(p_role, '')
  ),
  por_pessoa as (
    select view_key, allowed
    from agency_ops.dashboard_view_permissions
    where scope_type = 'PERSON'
      and scope_value = coalesce(p_person, '')
      and coalesce(p_role, '') <> 'DESIGN'
  ),
  final as (
    select coalesce(pessoa.view_key, papel.view_key) as view_key,
           coalesce(pessoa.allowed, papel.allowed) as allowed
    from por_papel papel
    full outer join por_pessoa pessoa on pessoa.view_key = papel.view_key
  )
  select coalesce(array_agg(view_key order by view_key), '{}'::text[])
  from final
  where allowed;
$function$;

create or replace function agency_ops.block_active_designer_person_permission_override()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public'
as $function$
begin
  if new.scope_type = 'PERSON' and exists (
    select 1 from agency_ops.team_roster tr
    where tr.person = new.scope_value
      and tr.role = 'DESIGN'
      and tr.is_former = false
  ) then
    raise exception 'DESIGN permissions are role-based; personal overrides are not allowed for active designers';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_block_designer_person_permission_override on agency_ops.dashboard_view_permissions;
create trigger trg_block_designer_person_permission_override
before insert or update on agency_ops.dashboard_view_permissions
for each row execute function agency_ops.block_active_designer_person_permission_override();

create or replace view agency_ops.designer_profile_consistency
with (security_invoker = true)
as
select
  tr.person,
  tr.role,
  tr.access_level,
  tim.clickup_user_id,
  tim.clickup_username,
  tim.auth_user_id,
  tim.sincronizado_pct,
  tim.faltando,
  agency_ops.dashboard_allowed_views(tr.person, tr.role) as allowed_views,
  coalesce(tover.clients_active,0) as agency_clients_active,
  coalesce(tover.clients_onboarding,0) as agency_clients_onboarding,
  coalesce(dpo.open_creative,0) as open_creative,
  coalesce(dpo.due_today,0) as due_today,
  coalesce(dpo.overdue,0) as overdue,
  coalesce(dpo.in_progress,0) as in_progress,
  coalesce(dpo.adjustments_reviews,0) as adjustments_reviews,
  coalesce(dpo.done_today,0) as done_today,
  coalesce(dpo.done_30d,0) as done_30d,
  coalesce(dpo.clients_touched_30d_or_open,0) as clients_touched_30d_or_open,
  coalesce(dpo.active_clients_touched,0) as active_clients_touched,
  dpo.last_done_at,
  case
    when tr.role <> 'DESIGN' then false
    when tr.access_level <> 'RESTRICTED' then false
    when exists (
      select 1 from agency_ops.dashboard_view_permissions p
      where p.scope_type='PERSON' and p.scope_value=tr.person
    ) then false
    else true
  end as profile_template_ok
from agency_ops.team_roster tr
left join agency_ops.team_identity_map tim on tim.person=tr.person
left join agency_ops.team_overview tover on tover.person=tr.person
left join agency_ops.designer_profile_overview dpo on dpo.person=tr.person
where tr.role='DESIGN' and tr.is_former=false;

revoke all on agency_ops.designer_profile_consistency from anon, authenticated;
grant select on agency_ops.designer_profile_consistency to service_role;
