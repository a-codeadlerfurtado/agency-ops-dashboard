create or replace function agency_ops.resolve_onboarding_required_alert(
  p_alert_id uuid,
  p_person text,
  p_user_key text,
  p_action text default 'ACK'::text,
  p_scheduled_date text default null::text,
  p_scheduled_time text default null::text,
  p_meet_url text default null::text
) returns jsonb
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog'
as $function$
declare
  v_alert agency_ops.onboarding_required_alerts%rowtype;
  v_stage_code text;
  v_stage_status text;
  v_scheduled timestamptz;
  v_meet_url text := nullif(btrim(coalesce(p_meet_url,'')),'');
  v_now timestamptz := now();
  v_next_present_at timestamptz;
  v_snooze_count integer;
begin
  select * into v_alert
  from agency_ops.onboarding_required_alerts
  where id=p_alert_id and target_person=p_person
  for update;

  if not found then raise exception 'ALERT_NOT_FOUND_OR_FORBIDDEN'; end if;

  if v_alert.acknowledged_at is not null then
    return jsonb_build_object(
      'ok',true,'id',v_alert.id,'already_acknowledged',true,
      'acknowledged_at',v_alert.acknowledged_at,'metadata',v_alert.metadata
    );
  end if;

  if upper(coalesce(p_action,'ACK'))='MEETING_SCHEDULED' then
    if v_alert.alert_type<>'ONBOARDING_MEETING_HANDOFF'
       or coalesce(v_alert.metadata->>'action_type','')<>'SCHEDULE_MEETING'
       or v_alert.onboarding_case_id is null then
      raise exception 'ALERT_DOES_NOT_SUPPORT_MEETING_SCHEDULE';
    end if;

    v_stage_code := nullif(v_alert.metadata->>'target_stage','');
    if v_stage_code not in ('INTRO_MEETING','PRODUCT_PERSONA_MEETING','INTEGRATION_MEETING') then
      raise exception 'INVALID_TARGET_STAGE';
    end if;
    if coalesce(p_scheduled_date,'') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'INVALID_SCHEDULED_DATE'; end if;
    if coalesce(p_scheduled_time,'') !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'INVALID_SCHEDULED_TIME'; end if;

    begin
      v_scheduled := ((p_scheduled_date||' '||p_scheduled_time)::timestamp at time zone 'America/Sao_Paulo');
    exception when others then
      raise exception 'INVALID_SCHEDULED_DATETIME';
    end;

    if v_meet_url is not null and v_meet_url !~ '^https://meet\.google\.com/[A-Za-z0-9-]+' then
      raise exception 'INVALID_GOOGLE_MEET_URL';
    end if;

    select status into v_stage_status
    from agency_ops.onboarding_stages
    where case_id=v_alert.onboarding_case_id and stage_code=v_stage_code
    for update;
    if v_stage_status is null then raise exception 'ONBOARDING_STAGE_NOT_FOUND'; end if;

    update agency_ops.onboarding_stages
    set status=case when status in ('DONE','IN_PROGRESS') then status else 'SCHEDULED' end,
        due_at=case when status='DONE' then due_at else v_scheduled end,
        blocked_type=case when status='DONE' then blocked_type else null end,
        notes=concat_ws(' | ',nullif(notes,''),
          'Reunião informada como já marcada por '||p_person||' via aviso obrigatório para '||
          to_char(v_scheduled at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'))
    where case_id=v_alert.onboarding_case_id and stage_code=v_stage_code;

    if v_meet_url is not null then
      update agency_ops.onboarding_stage_meet_links
      set is_current=false,updated_at=v_now
      where case_id=v_alert.onboarding_case_id and stage_code=v_stage_code and is_current;

      insert into agency_ops.onboarding_stage_meet_links(
        case_id,stage_code,url,provider,source,source_id,occurred_at,scheduled_for,is_current,metadata
      ) values (
        v_alert.onboarding_case_id,v_stage_code,v_meet_url,'GOOGLE_MEET','dashboard_required_alert',
        v_alert.id::text,v_now,v_scheduled,true,
        jsonb_build_object('recorded_by',p_person,'recorded_by_user_key',p_user_key,'required_alert_id',v_alert.id)
      );
    else
      update agency_ops.onboarding_stage_meet_links
      set scheduled_for=v_scheduled,updated_at=v_now,
          metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('schedule_confirmed_by',p_person,'schedule_confirmed_via','required_alert')
      where case_id=v_alert.onboarding_case_id and stage_code=v_stage_code and is_current;
    end if;

    insert into agency_ops.onboarding_events(case_id,event_type,source,source_id,occurred_at,metadata)
    select v_alert.onboarding_case_id,'MEETING_SCHEDULED_BY_RESPONSIBLE','dashboard_required_alert',v_alert.id::text,v_now,
      jsonb_strip_nulls(jsonb_build_object(
        'stage_code',v_stage_code,'scheduled_for',v_scheduled,'meet_url',v_meet_url,
        'recorded_by',p_person,'recorded_by_user_key',p_user_key
      ))
    where not exists (
      select 1 from agency_ops.onboarding_events
      where source='dashboard_required_alert' and source_id=v_alert.id::text and event_type='MEETING_SCHEDULED_BY_RESPONSIBLE'
    );

    update agency_ops.onboarding_required_alerts
    set acknowledged_at=v_now,
        acknowledged_by_user_key=p_user_key,
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object(
          'ack_action','MEETING_SCHEDULED',
          'acknowledged_person',p_person,
          'acknowledged_at',v_now,
          'scheduled_for',v_scheduled,
          'scheduled_date',p_scheduled_date,
          'scheduled_time',p_scheduled_time,
          'meet_url',v_meet_url,
          'meeting_stage',v_stage_code,
          'next_present_at',null
        ))
    where id=v_alert.id;

    return jsonb_build_object(
      'ok',true,'id',v_alert.id,'action','MEETING_SCHEDULED',
      'stage_code',v_stage_code,'scheduled_for',v_scheduled,'meet_url',v_meet_url
    );
  end if;

  if upper(coalesce(p_action,'ACK'))<>'ACK' then raise exception 'INVALID_ALERT_ACTION'; end if;

  if v_alert.alert_type='ONBOARDING_MEETING_HANDOFF'
     and coalesce(v_alert.metadata->>'action_type','')='SCHEDULE_MEETING' then
    v_next_present_at := v_now + interval '3 hours';
    v_snooze_count := coalesce((v_alert.metadata->>'snooze_count')::integer,0)+1;

    update agency_ops.onboarding_required_alerts
    set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'ack_action','SNOOZE_3H',
          'last_acknowledged_person',p_person,
          'last_acknowledged_by_user_key',p_user_key,
          'last_snoozed_at',v_now,
          'next_present_at',v_next_present_at,
          'snooze_count',v_snooze_count
        )
    where id=v_alert.id;

    return jsonb_build_object(
      'ok',true,'id',v_alert.id,'action','SNOOZE_3H',
      'snoozed_at',v_now,'next_present_at',v_next_present_at,
      'snooze_count',v_snooze_count
    );
  end if;

  update agency_ops.onboarding_required_alerts
  set acknowledged_at=v_now,
      acknowledged_by_user_key=p_user_key,
      metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
        'ack_action','ACK','acknowledged_person',p_person,'acknowledged_at',v_now
      )
  where id=v_alert.id;

  return jsonb_build_object('ok',true,'id',v_alert.id,'action','ACK','acknowledged_at',v_now);
end;
$function$;
