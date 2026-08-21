create table if not exists agency_ops.onboarding_gt_assignment_requests (
  id uuid primary key default gen_random_uuid(),
  case_id bigint not null unique references agency_ops.onboarding_cases(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING','ASSIGNED','CANCELLED')),
  trigger_status text,
  requested_at timestamptz not null default now(),
  assigned_gt text,
  assigned_carteira text,
  assigned_by text,
  assigned_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists onboarding_gt_assignment_requests_status_idx
  on agency_ops.onboarding_gt_assignment_requests(status, requested_at desc);
create index if not exists onboarding_gt_assignment_requests_client_idx
  on agency_ops.onboarding_gt_assignment_requests(client_id);

alter table agency_ops.onboarding_gt_assignment_requests enable row level security;
revoke all on agency_ops.onboarding_gt_assignment_requests from anon, authenticated;

create or replace function agency_ops.enqueue_onboarding_gt_assignment_request(p_case_id bigint, p_trigger_status text default null)
returns uuid
language plpgsql
security definer
set search_path = agency_ops, public
as $$
declare
  v_client_id uuid;
  v_gt_owner text;
  v_request_id uuid;
begin
  select oc.client_id, nullif(btrim(c.gt_owner), '')
    into v_client_id, v_gt_owner
  from agency_ops.onboarding_cases oc
  join agency_ops.clients c on c.id = oc.client_id
  where oc.id = p_case_id and oc.status = 'OPEN';

  if v_client_id is null or v_gt_owner is not null then
    return null;
  end if;

  insert into agency_ops.onboarding_gt_assignment_requests(
    case_id, client_id, status, trigger_status, requested_at, metadata, updated_at
  ) values (
    p_case_id, v_client_id, 'PENDING', p_trigger_status, now(),
    jsonb_build_object('source','INTRO_MEETING','reason','Primeira reunião de apresentação concluída ou superada por progressão'),
    now()
  )
  on conflict (case_id) do update
    set client_id = excluded.client_id,
        trigger_status = coalesce(excluded.trigger_status, agency_ops.onboarding_gt_assignment_requests.trigger_status),
        status = case when agency_ops.onboarding_gt_assignment_requests.status = 'ASSIGNED' then 'ASSIGNED' else 'PENDING' end,
        updated_at = now()
  returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function agency_ops.enqueue_onboarding_gt_assignment_request(bigint,text) from public, anon, authenticated;
grant execute on function agency_ops.enqueue_onboarding_gt_assignment_request(bigint,text) to service_role;

create or replace function agency_ops.trg_intro_meeting_requests_gt()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
begin
  if new.stage_code = 'INTRO_MEETING'
     and new.status in ('DONE','SKIPPED')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform agency_ops.enqueue_onboarding_gt_assignment_request(new.case_id, new.status);
  end if;
  return new;
end;
$$;

revoke all on function agency_ops.trg_intro_meeting_requests_gt() from public, anon, authenticated;

drop trigger if exists onboarding_intro_requests_gt on agency_ops.onboarding_stages;
create trigger onboarding_intro_requests_gt
after insert or update of status on agency_ops.onboarding_stages
for each row execute function agency_ops.trg_intro_meeting_requests_gt();

create or replace view agency_ops.gt_onboarding_worklist
with (security_invoker = true)
as
select
  c.id as client_id,
  c.display_name,
  c.lifecycle,
  c.entrada,
  c.gt_owner,
  wr.carteira,
  oc.id as onboarding_case_id,
  oc.onboarding_risk,
  oc.current_stage,
  oc.next_action,
  oc.next_action_due,
  im.status as integration_status,
  im.started_at as integration_started_at,
  im.due_at as integration_due_at,
  im.completed_at as integration_completed_at,
  im.notes as integration_notes,
  av.status as access_status,
  av.started_at as access_started_at,
  av.due_at as access_due_at,
  av.completed_at as access_completed_at,
  av.notes as access_notes,
  case
    when im.status = 'BLOCKED' or av.status = 'BLOCKED' then 'BLOCKED'
    when im.status = 'SCHEDULED' then 'SCHEDULED'
    when im.status = 'IN_PROGRESS' then 'IN_PROGRESS'
    when im.status in ('DONE','SKIPPED') and av.status in ('PENDING','SCHEDULED','IN_PROGRESS') then 'ACCESS_VALIDATION'
    when im.status = 'PENDING' then 'WAITING_SCHEDULING'
    else 'WAITING_SCHEDULING'
  end as integration_bucket
from agency_ops.clients c
join lateral (
  select o.*
  from agency_ops.onboarding_cases o
  where o.client_id = c.id and o.status = 'OPEN'
  order by o.updated_at desc, o.id desc
  limit 1
) oc on true
join agency_ops.onboarding_stages im
  on im.case_id = oc.id and im.stage_code = 'INTEGRATION_MEETING'
left join agency_ops.onboarding_stages av
  on av.case_id = oc.id and av.stage_code = 'ACCESS_VALIDATION'
left join agency_ops.wallet_registry wr
  on wr.gt_owner = c.gt_owner
where nullif(btrim(c.gt_owner), '') is not null
  and (
    im.status in ('PENDING','SCHEDULED','IN_PROGRESS','BLOCKED')
    or (im.status in ('DONE','SKIPPED') and av.status in ('PENDING','SCHEDULED','IN_PROGRESS','BLOCKED'))
  );

revoke all on agency_ops.gt_onboarding_worklist from anon, authenticated;
grant select on agency_ops.gt_onboarding_worklist to service_role;

create or replace function agency_ops.assign_onboarding_gt(
  p_request_id uuid,
  p_client_id uuid,
  p_gt_owner text,
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = agency_ops, public
as $$
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

  if not v_allowed then
    raise exception 'GT_NOT_ALLOWED';
  end if;

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

  update agency_ops.clients set gt_owner = p_gt_owner, updated_at = v_now where id = p_client_id;

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

  update agency_ops.onboarding_gt_assignment_requests
  set status = 'ASSIGNED', assigned_gt = p_gt_owner, assigned_carteira = v_carteira,
      assigned_by = p_actor, assigned_at = v_now, updated_at = v_now,
      metadata = metadata || jsonb_build_object(
        'previous_gt', v_old_gt, 'assigned_gt', p_gt_owner,
        'assigned_carteira', v_carteira, 'assigned_by', p_actor, 'assigned_at', v_now
      )
  where id = p_request_id;

  insert into agency_ops.client_lifecycle_events(
    event_key, client_id, event_type, occurred_at, source, actor,
    before_value, after_value, detail
  ) values (
    'onboarding:gt-assignment:' || p_request_id::text,
    p_client_id, 'GT_ASSIGNED', v_now, 'dashboard_onboarding_assignment', p_actor,
    jsonb_build_object('gt_owner', v_old_gt),
    jsonb_build_object('gt_owner', p_gt_owner, 'carteira', v_carteira),
    format('GT %s selecionado para %s; carteira %s.', p_gt_owner, v_client_name, coalesce(v_carteira,'sem codinome'))
  ) on conflict (event_key) do nothing;

  return jsonb_build_object(
    'ok', true, 'request_id', p_request_id, 'client_id', p_client_id,
    'client_name', v_client_name, 'onboarding_case_id', v_case_id,
    'gt_owner', p_gt_owner, 'carteira', v_carteira,
    'assigned_by', p_actor, 'assigned_at', v_now
  );
end;
$$;

revoke all on function agency_ops.assign_onboarding_gt(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function agency_ops.assign_onboarding_gt(uuid,uuid,text,text) to service_role;

select agency_ops.enqueue_onboarding_gt_assignment_request(s.case_id, s.status)
from agency_ops.onboarding_stages s
join agency_ops.onboarding_cases oc on oc.id = s.case_id and oc.status = 'OPEN'
join agency_ops.clients c on c.id = oc.client_id
where s.stage_code = 'INTRO_MEETING'
  and s.status in ('DONE','SKIPPED')
  and nullif(btrim(c.gt_owner), '') is null;
