create or replace function agency_ops.onboarding_business_days_elapsed(
  p_started timestamptz,
  p_finished timestamptz
)
returns integer
language sql
stable
set search_path to 'pg_catalog','agency_ops','public'
as $$
  select case
    when p_started is null or p_finished is null then null
    when p_finished <= p_started then 0
    else coalesce((
      select count(*)::integer
      from generate_series(
        (p_started at time zone 'America/Sao_Paulo')::date + 1,
        (p_finished at time zone 'America/Sao_Paulo')::date,
        interval '1 day'
      ) as d(day)
      where extract(isodow from d.day) between 1 and 5
    ), 0)
  end;
$$;

create or replace function agency_ops.enforce_onboarding_history_expected_sla()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public'
as $$
declare
  v_business_days integer;
  v_sla constant integer := 7;
begin
  v_business_days := agency_ops.onboarding_business_days_elapsed(new.opened_at, new.first_campaign_at);

  new.summary := coalesce(new.summary, '{}'::jsonb) || jsonb_build_object(
    'business_days_elapsed', v_business_days,
    'expected_sla_business_days', v_sla,
    'business_day_rule', 'weekdays_after_opening_through_first_campaign'
  );

  -- CRITICAL continua soberano; ATTENTION por falha/atraso também não é rebaixado.
  -- Acima de 7 dias úteis jamais pode constar como EXPECTED.
  if coalesce(new.evaluation_status, '') <> 'CRITICAL'
     and v_business_days is not null
     and v_business_days > v_sla then
    if coalesce(new.evaluation_status, '') = 'EXPECTED' then
      new.evaluation_reason := format(
        'Onboarding finalizado em %s dias úteis; para ficar dentro do esperado o limite é %s dias úteis.',
        v_business_days, v_sla
      );
    elsif position('limite é 7 dias úteis' in coalesce(new.evaluation_reason, '')) = 0 then
      new.evaluation_reason := concat_ws(
        ' ',
        nullif(btrim(coalesce(new.evaluation_reason, '')), ''),
        format('Duração total: %s dias úteis; o limite para ficar dentro do esperado é %s dias úteis.', v_business_days, v_sla)
      );
    end if;
    new.evaluation_status := 'ATTENTION';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_onboarding_history_expected_sla on agency_ops.onboarding_history_snapshots;
create trigger trg_onboarding_history_expected_sla
before insert or update of opened_at,first_campaign_at,evaluation_status,evaluation_reason,summary
on agency_ops.onboarding_history_snapshots
for each row execute function agency_ops.enforce_onboarding_history_expected_sla();

update agency_ops.onboarding_history_snapshots
set summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object(
      'business_days_elapsed', agency_ops.onboarding_business_days_elapsed(opened_at, first_campaign_at),
      'expected_sla_business_days', 7,
      'business_day_rule', 'weekdays_after_opening_through_first_campaign'
    ),
    evaluation_status = case
      when evaluation_status = 'EXPECTED'
       and agency_ops.onboarding_business_days_elapsed(opened_at, first_campaign_at) > 7
      then 'ATTENTION'
      else evaluation_status
    end,
    evaluation_reason = case
      when evaluation_status = 'EXPECTED'
       and agency_ops.onboarding_business_days_elapsed(opened_at, first_campaign_at) > 7
      then format(
        'Onboarding finalizado em %s dias úteis; para ficar dentro do esperado o limite é 7 dias úteis.',
        agency_ops.onboarding_business_days_elapsed(opened_at, first_campaign_at)
      )
      else evaluation_reason
    end;

create or replace function agency_ops.enforce_onboarding_history_notification_sla()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public'
as $$
declare
  v_case_id bigint;
  v_eval text;
  v_days integer;
begin
  if new.type <> 'ONBOARDING_COMPLETED_HISTORY' then
    return new;
  end if;

  begin
    v_case_id := nullif(new.metadata->>'onboarding_history_case_id','')::bigint;
  exception when others then
    v_case_id := null;
  end;

  if v_case_id is null then return new; end if;

  select evaluation_status,
         agency_ops.onboarding_business_days_elapsed(opened_at, first_campaign_at)
    into v_eval, v_days
  from agency_ops.onboarding_history_snapshots
  where case_id = v_case_id;

  if found then
    new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'evaluation_status', v_eval,
      'business_days_elapsed', v_days,
      'expected_sla_business_days', 7
    );
    if v_eval in ('ATTENTION','CRITICAL') then new.level := 'WARNING'; end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_onboarding_history_notification_sla on agency_ops.platform_notifications;
create trigger trg_onboarding_history_notification_sla
before insert or update of type,level,metadata
on agency_ops.platform_notifications
for each row execute function agency_ops.enforce_onboarding_history_notification_sla();

update agency_ops.platform_notifications n
set level = case when s.evaluation_status in ('ATTENTION','CRITICAL') then 'WARNING' else n.level end,
    metadata = coalesce(n.metadata, '{}'::jsonb) || jsonb_build_object(
      'evaluation_status', s.evaluation_status,
      'business_days_elapsed', agency_ops.onboarding_business_days_elapsed(s.opened_at, s.first_campaign_at),
      'expected_sla_business_days', 7
    )
from agency_ops.onboarding_history_snapshots s
where n.type = 'ONBOARDING_COMPLETED_HISTORY'
  and nullif(n.metadata->>'onboarding_history_case_id','') ~ '^\d+$'
  and (n.metadata->>'onboarding_history_case_id')::bigint = s.case_id;
