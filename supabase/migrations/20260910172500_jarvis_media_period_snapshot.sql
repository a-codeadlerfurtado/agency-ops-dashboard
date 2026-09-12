-- Jarvis: consulta deterministica de midia historica por periodo.
-- Usa meta_campaign_insights diario; modelo nenhum escolhe cliente/periodo/contagem.
create or replace function agency_ops.jarvis_media_period_snapshot(
  p_since date,
  p_until date,
  p_client_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person text;
  v_role text;
  v_client agency_ops.jarvis_client_state%rowtype;
  v_leads numeric;
  v_spend numeric;
  v_checked_at timestamptz;
  v_first_date date;
  v_last_date date;
  v_days integer;
  v_clients integer;
  v_expected integer;
begin
  if p_since is null or p_until is null or p_since > p_until or (p_until - p_since) > 89 then
    return jsonb_build_object('ok', false, 'error', 'invalid_period');
  end if;
  v_expected := (p_until - p_since) + 1;
  select tr.person, upper(tr.role)
    into v_person, v_role
  from agency_ops.user_preferences up
  join agency_ops.team_roster tr on tr.person = up.collaborator_person and tr.is_former = false
  where up.user_key = auth.uid()::text
  limit 1;
  if v_role is null then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_client_id is not null then
    select * into v_client from agency_ops.jarvis_client_state where client_id = p_client_id;
    if not found then return jsonb_build_object('ok', false, 'error', 'client_not_found'); end if;
    if v_role <> 'MGMT'
       and not (v_role = 'GT' and v_client.gt_owner = v_person)
       and not (v_role = 'CS' and v_client.cs_owner = v_person)
       and not (v_role = 'DESIGN' and v_client.designer_owner = v_person) then
      return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;
  elsif v_role <> 'MGMT' then
    return jsonb_build_object('ok', false, 'error', 'forbidden_global');
  end if;

  select sum(i.leads_estimate), sum(i.spend), max(i.checked_at),
         min(i.date_start), max(i.date_start), count(distinct i.date_start)::int,
         count(distinct i.client_id)::int
    into v_leads, v_spend, v_checked_at, v_first_date, v_last_date, v_days, v_clients
  from agency_ops.meta_campaign_insights i
  join agency_ops.clients c on c.id = i.client_id
  where i.date_start = i.date_stop
    and i.date_start between p_since and p_until
    and (
      (p_client_id is not null and i.client_id = p_client_id)
      or (p_client_id is null and c.lifecycle in ('ACTIVE','ONBOARDING'))
    );

  if v_checked_at is null then
    return jsonb_build_object(
      'ok', false, 'error', 'no_data', 'client_id', p_client_id,
      'since', p_since, 'until', p_until, 'expected_days', v_expected
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'source', 'META_CAMPAIGN_INSIGHTS',
    'client_id', p_client_id,
    'display_name', case when p_client_id is null then null else v_client.display_name end,
    'since', p_since, 'until', p_until,
    'leads', coalesce(v_leads,0), 'spend', coalesce(v_spend,0),
    'cpl', case when coalesce(v_leads,0) > 0 then v_spend / v_leads else null end,
    'available_from', v_first_date, 'available_until', v_last_date,
    'coverage_days', v_days, 'expected_days', v_expected,
    'complete', v_days >= v_expected,
    'client_count', v_clients, 'checked_at', v_checked_at
  );
end;
$$;

revoke execute on function agency_ops.jarvis_media_period_snapshot(date,date,uuid) from public, anon;
grant execute on function agency_ops.jarvis_media_period_snapshot(date,date,uuid) to authenticated, service_role;
