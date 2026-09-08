-- Índices operacionais dinâmicos para perguntas rápidas de equipe/carteira.
create or replace function agency_ops.jarvis_operation_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_state agency_ops.jarvis_operation_state%rowtype;
  v_owner_active jsonb;
  v_owner_onboarding jsonb;
  v_team_members jsonb;
begin
  select upper(tr.role) into v_role
  from agency_ops.user_preferences up
  join agency_ops.team_roster tr
    on tr.person = up.collaborator_person and tr.is_former = false
  where up.user_key = auth.uid()::text
  limit 1;
  if v_role <> 'MGMT' then return null; end if;

  select * into v_state
  from agency_ops.jarvis_operation_state
  where state_key = 'global';
  if not found then return null; end if;
  select coalesce(jsonb_object_agg(x.owner, x.cnt), '{}'::jsonb)
    into v_owner_active
  from (
    select gt_owner as owner, count(*)::integer as cnt
    from agency_ops.jarvis_client_state
    where lifecycle = 'ACTIVE' and gt_owner is not null
    group by gt_owner
  ) x;

  select coalesce(jsonb_object_agg(x.owner, x.cnt), '{}'::jsonb)
    into v_owner_onboarding
  from (
    select gt_owner as owner, count(*)::integer as cnt
    from agency_ops.jarvis_client_state
    where lifecycle = 'ONBOARDING' and gt_owner is not null
    group by gt_owner
  ) x;

  select coalesce(jsonb_object_agg(x.role, x.people), '{}'::jsonb)
    into v_team_members
  from (
    select upper(role) as role, jsonb_agg(person order by person) as people
    from agency_ops.team_roster
    where is_former = false
    group by upper(role)
  ) x;
  return to_jsonb(v_state) || jsonb_build_object(
    'owner_active_counts', v_owner_active,
    'owner_onboarding_counts', v_owner_onboarding,
    'team_members', v_team_members
  );
end;
$$;

revoke execute on function agency_ops.jarvis_operation_snapshot() from public, anon;
grant execute on function agency_ops.jarvis_operation_snapshot() to authenticated, service_role;
