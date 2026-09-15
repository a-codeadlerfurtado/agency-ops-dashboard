create or replace function agency_ops.onboarding_business_days(p_start timestamptz, p_end timestamptz)
returns integer
language sql
immutable
set search_path = agency_ops, public
as $$
  select case
    when p_start is null or p_end is null then null
    when p_end <= p_start then 0
    else coalesce((
      select count(*)::integer
      from generate_series(
        (((p_start at time zone 'America/Sao_Paulo')::date + 1)::timestamp),
        (((p_end at time zone 'America/Sao_Paulo')::date)::timestamp),
        interval '1 day'
      ) d
      where extract(isodow from d) between 1 and 5
    ), 0)
  end;
$$;

create or replace function agency_ops.normalize_onboarding_history_sla()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
declare
  v_days integer;
  v_status text;
  v_reason text;
begin
  if new.opened_at is null or new.first_campaign_at is null then return new; end if;

  v_days := agency_ops.onboarding_business_days(new.opened_at, new.first_campaign_at);
  if coalesce(v_days, 0) <= 7 then
    v_status := 'EXPECTED';
    v_reason := format(
      'Onboarding finalizado em %s. Dentro do SLA de até 7 dias úteis.',
      case when v_days = 1 then '1 dia útil' else v_days::text || ' dias úteis' end
    );
  else
    v_status := 'ATTENTION';
    v_reason := format(
      'Onboarding finalizado em %s. SLA estourado: limite de 7 dias úteis.',
      v_days::text || ' dias úteis'
    );
  end if;

  new.evaluation_status := v_status;
  new.evaluation_reason := v_reason;
  new.summary := coalesce(new.summary, '{}'::jsonb) || jsonb_build_object(
    'completion_status', 'FINALIZED',
    'business_days', v_days,
    'sla_limit_business_days', 7,
    'sla_status', case when v_status = 'EXPECTED' then 'WITHIN_SLA' else 'SLA_BREACHED' end,
    'sla_policy_version', '7-business-days-v2'
  );
  return new;
end;
$$;

drop trigger if exists trg_onboarding_history_expected_sla on agency_ops.onboarding_history_snapshots;
drop function if exists agency_ops.enforce_onboarding_history_expected_sla();

drop trigger if exists trg_normalize_onboarding_history_sla on agency_ops.onboarding_history_snapshots;
create trigger trg_normalize_onboarding_history_sla
before insert or update of opened_at, first_campaign_at, evaluation_status, evaluation_reason
on agency_ops.onboarding_history_snapshots
for each row execute function agency_ops.normalize_onboarding_history_sla();

create or replace function agency_ops.normalize_onboarding_history_notification_sla()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
declare
  v_case_id bigint;
  v_days integer;
  v_sla_status text;
begin
  if new.type <> 'ONBOARDING_COMPLETED_HISTORY' then return new; end if;

  begin
    v_case_id := nullif(new.metadata->>'onboarding_history_case_id','')::bigint;
  exception when others then
    v_case_id := null;
  end;
  if v_case_id is null then return new; end if;

  select coalesce((s.summary->>'business_days')::integer, agency_ops.onboarding_business_days(s.opened_at, s.first_campaign_at)),
         coalesce(s.summary->>'sla_status', case when s.evaluation_status='EXPECTED' then 'WITHIN_SLA' else 'SLA_BREACHED' end)
    into v_days, v_sla_status
  from agency_ops.onboarding_history_snapshots s
  where s.case_id = v_case_id;

  if v_days is null then return new; end if;

  new.level := case when v_sla_status='WITHIN_SLA' then 'INFO' else 'WARNING' end;
  new.description := format(
    'Onboarding finalizado em %s. %s',
    case when v_days = 1 then '1 dia útil' else v_days::text || ' dias úteis' end,
    case when v_sla_status='WITHIN_SLA' then 'Dentro do SLA de até 7 dias úteis.' else 'SLA estourado: limite de 7 dias úteis.' end
  );
  new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
    'completion_status','FINALIZED',
    'business_days',v_days,
    'sla_limit_business_days',7,
    'sla_status',v_sla_status,
    'evaluation_status',case when v_sla_status='WITHIN_SLA' then 'EXPECTED' else 'ATTENTION' end
  );
  return new;
end;
$$;

drop trigger if exists trg_normalize_onboarding_history_notification_sla on agency_ops.platform_notifications;
create trigger trg_normalize_onboarding_history_notification_sla
before insert or update of type, description, metadata
on agency_ops.platform_notifications
for each row execute function agency_ops.normalize_onboarding_history_notification_sla();

update agency_ops.onboarding_history_snapshots
set evaluation_status = evaluation_status,
    evaluation_reason = evaluation_reason
where opened_at is not null and first_campaign_at is not null;

update agency_ops.platform_notifications
set metadata = metadata
where type = 'ONBOARDING_COMPLETED_HISTORY';
