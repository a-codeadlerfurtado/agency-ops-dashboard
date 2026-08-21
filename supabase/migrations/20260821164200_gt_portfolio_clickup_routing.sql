create or replace function agency_ops.resolve_gt_clickup_assignee(p_client_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, agency_ops
as $$
  select jsonb_build_object(
    'ok', (c.id is not null and nullif(trim(c.gt_owner), '') is not null and nullif(trim(t.clickup_user_id), '') is not null),
    'client_id', c.id,
    'client_name', c.display_name,
    'lifecycle', c.lifecycle,
    'gt_owner', c.gt_owner,
    'clickup_user_id', t.clickup_user_id,
    'clickup_username', t.clickup_username,
    'reason', case
      when c.id is null then 'client_not_found'
      when nullif(trim(c.gt_owner), '') is null then 'client_without_gt_owner'
      when t.person is null then 'gt_not_in_team_identity_map'
      when coalesce(t.role, '') <> 'GT' then 'resolved_person_is_not_gt'
      when nullif(trim(t.clickup_user_id), '') is null then 'gt_without_clickup_user_id'
      else 'resolved_from_client_portfolio'
    end
  )
  from (select 1) s
  left join agency_ops.clients c on c.id = p_client_id
  left join agency_ops.team_identity_map t on t.person = c.gt_owner;
$$;

revoke all on function agency_ops.resolve_gt_clickup_assignee(uuid) from public, anon, authenticated;
grant execute on function agency_ops.resolve_gt_clickup_assignee(uuid) to service_role;

alter table agency_ops.generated_tasks
  add column if not exists resolved_assignee_person text,
  add column if not exists resolved_clickup_user_id text,
  add column if not exists assignment_source text;

comment on function agency_ops.resolve_gt_clickup_assignee(uuid) is
  'Resolve deterministicamente o GT do cliente pela carteira agency_ops.clients.gt_owner e mapeia para team_identity_map.clickup_user_id.';
comment on column agency_ops.generated_tasks.resolved_assignee_person is
  'Responsavel deterministico resolvido pela carteira do cliente antes do envio ao ClickUp.';
comment on column agency_ops.generated_tasks.resolved_clickup_user_id is
  'ID do usuario ClickUp usado no envio deterministico.';
comment on column agency_ops.generated_tasks.assignment_source is
  'Fonte usada para resolver o responsavel da task.';
