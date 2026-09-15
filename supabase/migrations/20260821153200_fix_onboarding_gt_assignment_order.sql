-- Corrige a ordem da atribuição de GT no onboarding.
-- O trigger em clients.gt_owner exige evidência humana prévia em gt_assignments.
-- Portanto, gt_assignments precisa ser confirmado antes de atualizar clients.gt_owner.

create or replace function agency_ops.assign_onboarding_gt(p_request_id uuid, p_client_id uuid, p_gt_owner text, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path to 'agency_ops', 'public'
as $function$
declare
  v_request agency_ops.onboarding_gt_assignment_requests%rowtype;
  v_client_name text;
  v_old_gt text;
  v_carteira text;
  v_case_id bigint;
  v_updated_count integer := 0;
  v_allowed boolean := false;
  v_now timestamptz := now();
begin
  select exists (
    select 1
    from (
      select wr.gt_owner
      from agency_ops.wallet_registry wr
      join agency_ops.team_roster tr
        on tr.person = wr.gt_owner
       and tr.role = 'GT'
       and coalesce(tr.is_former,false) = false
      order by wr.ordem
      limit 3
    ) allowed
    where allowed.gt_owner = p_gt_owner
  ) into v_allowed;

  if not v_allowed then raise exception 'GT_NOT_ALLOWED'; end if;

  select * into v_request
  from agency_ops.onboarding_gt_assignment_requests
  where id = p_request_id
  for update;

  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if v_request.client_id <> p_client_id then raise exception 'CLIENT_MISMATCH'; end if;
  if v_request.status <> 'PENDING' then raise exception 'REQUEST_ALREADY_RESOLVED'; end if;

  select c.display_name, c.gt_owner
    into v_client_name, v_old_gt
  from agency_ops.clients c
  where c.id = p_client_id
  for update;

  if not found then raise exception 'CLIENT_NOT_FOUND'; end if;

  select wr.carteira into v_carteira
  from agency_ops.wallet_registry wr
  where wr.gt_owner = p_gt_owner;

  v_case_id := v_request.case_id;

  update agency_ops.gt_assignments
  set gt_owner = p_gt_owner,
      assignment_status = 'ASSIGNED',
      human_confirmed = true,
      evidence_type = 'dashboard_onboarding_assignment',
      evidence_text = 'Gestor de tráfego selecionado na notificação de onboarding após a primeira reunião de apresentação.',
      evidence_ref = p_request_id::text,
      assigned_by = p_actor,
      assigned_at = v_now,
      notes = concat_ws(' | ', nullif(notes,''), 'Atribuição feita pelo fluxo de onboarding do dashboard.'),
      updated_at = v_now
  where client_id = p_client_id;
  get diagnostics v_updated_count = row_count;

  if v_updated_count = 0 then
    insert into agency_ops.gt_assignments(
      client_id, client_name, gt_owner, assignment_status, human_confirmed,
      evidence_type, evidence_text, evidence_ref, assigned_by, assigned_at, notes, updated_at
    ) values (
      p_client_id, v_client_name, p_gt_owner, 'ASSIGNED', true,
      'dashboard_onboarding_assignment',
      'Gestor de tráfego selecionado na notificação de onboarding após a primeira reunião de apresentação.',
      p_request_id::text, p_actor, v_now,
      'Atribuição feita pelo fluxo de onboarding do dashboard.', v_now
    );
  end if;

  update agency_ops.clients
  set gt_owner = p_gt_owner,
      updated_at = v_now
  where id = p_client_id;

  update agency_ops.onboarding_gt_assignment_requests
  set status = 'ASSIGNED',
      assigned_gt = p_gt_owner,
      assigned_carteira = v_carteira,
      assigned_by = p_actor,
      assigned_at = v_now,
      updated_at = v_now,
      metadata = metadata || jsonb_build_object(
        'previous_gt', v_old_gt,
        'assigned_gt', p_gt_owner,
        'assigned_carteira', v_carteira,
        'assigned_by', p_actor,
        'assigned_at', v_now
      )
  where id = p_request_id;

  insert into agency_ops.client_lifecycle_events(
    event_key, client_id, event_type, occurred_at, source, actor,
    before_value, after_value, detail
  ) values (
    'onboarding:gt-assignment:' || p_request_id::text,
    p_client_id,
    'GT_ASSIGNED',
    v_now,
    'dashboard_onboarding_assignment',
    p_actor,
    jsonb_build_object('gt_owner', v_old_gt),
    jsonb_build_object('gt_owner', p_gt_owner, 'carteira', v_carteira),
    format('GT %s selecionado para %s; carteira %s.', p_gt_owner, v_client_name, coalesce(v_carteira,'sem codinome'))
  ) on conflict (event_key) do nothing;

  return jsonb_build_object(
    'ok', true,
    'request_id', p_request_id,
    'client_id', p_client_id,
    'client_name', v_client_name,
    'onboarding_case_id', v_case_id,
    'gt_owner', p_gt_owner,
    'carteira', v_carteira,
    'assigned_by', p_actor,
    'assigned_at', v_now
  );
end;
$function$;
