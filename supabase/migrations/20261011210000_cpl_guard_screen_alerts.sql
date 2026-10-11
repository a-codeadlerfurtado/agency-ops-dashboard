-- CPL Guard: aviso de tela cheia (toma a tela) para o GT do cliente e para o Adler.
--   GT:    botão "Ciente".
--   Adler: "Ciente" ou "Alertar GT". Alertar GT tira o aviso da tela do Adler e
--          reabre o aviso na tela do GT (mesmo que ele já tenha dado ciente).
-- Exceção deliberada à política notification-first do Adler, pedida em 11/10/2026.

create table if not exists agency_ops.cpl_guard_screen_alerts (
  id uuid primary key default gen_random_uuid(),
  event_id bigint not null references agency_ops.cpl_guard_events(id) on delete cascade,
  recipient_person text not null,
  recipient_role text not null check (recipient_role in ('GT', 'MGMT')),
  client_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'OPEN' check (status in ('OPEN', 'CIENTE', 'GT_ALERTADO')),
  escalated_count integer not null default 0,
  escalated_by text,
  escalated_at timestamptz,
  action_by text,
  action_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, recipient_person)
);
create index if not exists cpl_guard_screen_alerts_open_idx
  on agency_ops.cpl_guard_screen_alerts (recipient_person, status, created_at desc);

alter table agency_ops.cpl_guard_screen_alerts enable row level security;
drop policy if exists cpl_guard_screen_alerts_own on agency_ops.cpl_guard_screen_alerts;
create policy cpl_guard_screen_alerts_own on agency_ops.cpl_guard_screen_alerts
  for select to authenticated
  using (recipient_person = agency_ops.current_authenticated_collaborator_person());
revoke all on agency_ops.cpl_guard_screen_alerts from anon, authenticated;
grant usage on schema agency_ops to authenticated;
grant select on agency_ops.cpl_guard_screen_alerts to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                 and schemaname = 'agency_ops' and tablename = 'cpl_guard_screen_alerts') then
    alter publication supabase_realtime add table agency_ops.cpl_guard_screen_alerts;
  end if;
end $$;

-- Chamado pela edge function quando a pausa é lida: abre o aviso para o GT e para o Adler.
create or replace function agency_ops.cpl_guard_open_screen_alerts(p_event_id bigint, p_payload jsonb, p_notify_manager boolean default true)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, agency_ops, public, extensions
as $$
declare
  v_event agency_ops.cpl_guard_events;
  v_count integer := 0;
begin
  select * into v_event from agency_ops.cpl_guard_events where id = p_event_id;
  if not found then return 0; end if;
  if nullif(trim(coalesce(v_event.gt_owner, '')), '') is not null then
    insert into agency_ops.cpl_guard_screen_alerts (event_id, recipient_person, recipient_role, client_id, payload)
    values (p_event_id, v_event.gt_owner, 'GT', v_event.client_id, p_payload)
    on conflict (event_id, recipient_person) do nothing;
    get diagnostics v_count = row_count;
  end if;
  if p_notify_manager and coalesce(v_event.gt_owner, '') <> 'Adler Furtado' then
    insert into agency_ops.cpl_guard_screen_alerts (event_id, recipient_person, recipient_role, client_id, payload)
    values (p_event_id, 'Adler Furtado', 'MGMT', v_event.client_id, p_payload)
    on conflict (event_id, recipient_person) do nothing;
    v_count := v_count + 1;
  end if;
  return v_count;
end;
$$;
revoke all on function agency_ops.cpl_guard_open_screen_alerts(bigint, jsonb, boolean) from public, anon, authenticated;

-- Botões do aviso.
create or replace function agency_ops.cpl_guard_alert_action(p_id uuid, p_action text)
returns agency_ops.cpl_guard_screen_alerts
language plpgsql
security definer
set search_path = pg_catalog, agency_ops, public, extensions
as $$
declare
  v_actor text := agency_ops.current_authenticated_collaborator_person();
  v_action text := upper(trim(coalesce(p_action, '')));
  v_row agency_ops.cpl_guard_screen_alerts;
  v_event agency_ops.cpl_guard_events;
  v_gt_row agency_ops.cpl_guard_screen_alerts;
begin
  if v_actor is null then raise exception 'unauthorized'; end if;
  select * into v_row from agency_ops.cpl_guard_screen_alerts
  where id = p_id and recipient_person = v_actor for update;
  if not found then raise exception 'alert_not_found_or_forbidden'; end if;
  if v_action not in ('CIENTE', 'ALERTAR_GT') then raise exception 'invalid_action'; end if;
  select * into v_event from agency_ops.cpl_guard_events where id = v_row.event_id;

  if v_action = 'ALERTAR_GT' then
    if v_row.recipient_role <> 'MGMT' then raise exception 'only_manager_can_alert_gt'; end if;
    if nullif(trim(coalesce(v_event.gt_owner, '')), '') is null then raise exception 'cliente_sem_gt'; end if;
    insert into agency_ops.cpl_guard_screen_alerts
      (event_id, recipient_person, recipient_role, client_id, payload, status, escalated_count, escalated_by, escalated_at)
    values
      (v_row.event_id, v_event.gt_owner, 'GT', v_row.client_id, v_row.payload, 'OPEN', 1, v_actor, now())
    on conflict (event_id, recipient_person) do update set
      status = 'OPEN',
      escalated_count = agency_ops.cpl_guard_screen_alerts.escalated_count + 1,
      escalated_by = v_actor,
      escalated_at = now(),
      action_by = null,
      action_at = null,
      updated_at = now()
    returning * into v_gt_row;
  end if;

  update agency_ops.cpl_guard_screen_alerts
  set status = case when v_action = 'ALERTAR_GT' then 'GT_ALERTADO' else 'CIENTE' end,
      action_by = v_actor, action_at = now(), updated_at = now()
  where id = p_id
  returning * into v_row;

  -- Sai também da Central de Notificações de quem agiu.
  insert into agency_ops.platform_notification_resolutions (notification_id, user_key, resolved_by, resolution_note)
  select n.id, auth.uid()::text, v_actor,
         case when v_action = 'ALERTAR_GT' then 'Pausa por CPL: GT alertado' else 'Pausa por CPL: ciente' end
  from agency_ops.platform_notifications n
  where n.event_key = 'cpl-guard:' || v_event.event_key
  on conflict (notification_id, user_key) do nothing;

  return v_row;
end;
$$;
revoke all on function agency_ops.cpl_guard_alert_action(uuid, text) from public, anon;
grant execute on function agency_ops.cpl_guard_alert_action(uuid, text) to authenticated;
