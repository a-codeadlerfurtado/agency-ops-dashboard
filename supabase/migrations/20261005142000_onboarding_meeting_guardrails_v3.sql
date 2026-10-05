-- Onboarding meeting guardrails v3
-- Keeps the three onboarding meetings synchronized with required alerts,
-- acknowledgements, reminders, completion confirmation, and the meeting radar.
-- Source synchronized with the production definitions after validation on 2026-10-05.

CREATE OR REPLACE FUNCTION agency_ops.resolve_onboarding_required_alert(p_alert_id uuid, p_person text, p_user_key text, p_action text DEFAULT 'ACK'::text, p_scheduled_date text DEFAULT NULL::text, p_scheduled_time text DEFAULT NULL::text, p_meet_url text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agency_ops', 'public', 'pg_catalog'
AS $function$
declare
  v_alert agency_ops.onboarding_required_alerts%rowtype;
  v_stage_code text;
  v_stage_status text;
  v_scheduled timestamptz;
  v_meet_url text := nullif(btrim(coalesce(p_meet_url,'')),'');
  v_now timestamptz := now();
  v_next_present_at timestamptz;
  v_snooze_count integer;
  v_action text := upper(coalesce(p_action,'ACK'));
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

  v_stage_code := nullif(v_alert.metadata->>'target_stage','');

  if v_action in ('MEETING_SCHEDULED','MEETING_COMPLETED') then
    if v_alert.onboarding_case_id is null
       or v_stage_code not in ('INTRO_MEETING','PRODUCT_PERSONA_MEETING','INTEGRATION_MEETING') then
      raise exception 'ALERT_DOES_NOT_SUPPORT_MEETING_ACTION';
    end if;
    if coalesce(p_scheduled_date,'') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'INVALID_SCHEDULED_DATE'; end if;
    if coalesce(p_scheduled_time,'') !~ '^([01]\d|2[0-3]):[0-5]\d$' then raise exception 'INVALID_SCHEDULED_TIME'; end if;

    begin
      v_scheduled := ((p_scheduled_date||' '||p_scheduled_time)::timestamp at time zone 'America/Sao_Paulo');
    exception when others then
      raise exception 'INVALID_SCHEDULED_DATETIME';
    end;

    if v_action='MEETING_COMPLETED' and v_scheduled > v_now + interval '15 minutes' then
      raise exception 'MEETING_COMPLETION_IN_FUTURE';
    end if;

    if v_meet_url is not null and v_meet_url !~ '^https://meet\.google\.com/[A-Za-z0-9-]+' then
      raise exception 'INVALID_GOOGLE_MEET_URL';
    end if;

    select status into v_stage_status
    from agency_ops.onboarding_stages
    where case_id=v_alert.onboarding_case_id and stage_code=v_stage_code
    for update;
    if v_stage_status is null then raise exception 'ONBOARDING_STAGE_NOT_FOUND'; end if;

    if v_action='MEETING_SCHEDULED' then
      if coalesce(v_alert.metadata->>'action_type','') not in ('SCHEDULE_MEETING','CONFIRM_MEETING_OUTCOME') then
        raise exception 'ALERT_DOES_NOT_SUPPORT_MEETING_SCHEDULE';
      end if;

      update agency_ops.onboarding_stages
      set status=case when status='DONE' then status else 'SCHEDULED' end,
          started_at=case when status='DONE' then started_at else coalesce(started_at,v_now) end,
          due_at=case when status='DONE' then due_at else v_scheduled end,
          blocked_type=case when status='DONE' then blocked_type else null end,
          notes=concat_ws(' | ',nullif(notes,''),
            'Reunião informada como marcada/reagendada por '||p_person||' via aviso obrigatório para '||
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

      perform agency_ops.recalculate_onboarding_case(v_alert.onboarding_case_id);

      return jsonb_build_object(
        'ok',true,'id',v_alert.id,'action','MEETING_SCHEDULED',
        'stage_code',v_stage_code,'scheduled_for',v_scheduled,'meet_url',v_meet_url
      );
    end if;

    update agency_ops.onboarding_stages
    set status='DONE',
        started_at=coalesce(started_at,v_scheduled),
        completed_at=coalesce(completed_at,v_scheduled),
        due_at=coalesce(due_at,v_scheduled),
        blocked_type=null,
        notes=concat_ws(' | ',nullif(notes,''),
          'Reunião confirmada como realizada por '||p_person||' via aviso obrigatório em '||
          to_char(v_scheduled at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'))
    where case_id=v_alert.onboarding_case_id and stage_code=v_stage_code and status<>'DONE';

    insert into agency_ops.onboarding_events(case_id,event_type,source,source_id,occurred_at,metadata)
    select v_alert.onboarding_case_id,'MEETING_COMPLETED_BY_RESPONSIBLE','dashboard_required_alert',v_alert.id::text,v_now,
      jsonb_build_object(
        'stage_code',v_stage_code,'completed_at',v_scheduled,
        'recorded_by',p_person,'recorded_by_user_key',p_user_key
      )
    where not exists (
      select 1 from agency_ops.onboarding_events
      where source='dashboard_required_alert' and source_id=v_alert.id::text and event_type='MEETING_COMPLETED_BY_RESPONSIBLE'
    );

    update agency_ops.onboarding_required_alerts
    set acknowledged_at=coalesce(acknowledged_at,v_now),
        acknowledged_by_user_key=coalesce(acknowledged_by_user_key,p_user_key),
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'ack_action',case when id=v_alert.id then 'MEETING_COMPLETED' else 'AUTO_RESOLVED_STAGE_COMPLETED' end,
          'acknowledged_person',case when id=v_alert.id then p_person else coalesce(metadata->>'acknowledged_person','Sistema') end,
          'acknowledged_at',v_now,
          'completed_at',v_scheduled,
          'meeting_stage',v_stage_code,
          'next_present_at',null
        )
    where onboarding_case_id=v_alert.onboarding_case_id
      and acknowledged_at is null
      and metadata->>'target_stage'=v_stage_code;

    perform agency_ops.recalculate_onboarding_case(v_alert.onboarding_case_id);

    return jsonb_build_object(
      'ok',true,'id',v_alert.id,'action','MEETING_COMPLETED',
      'stage_code',v_stage_code,'completed_at',v_scheduled
    );
  end if;

  if v_action<>'ACK' then raise exception 'INVALID_ALERT_ACTION'; end if;

  if (v_alert.alert_type='ONBOARDING_MEETING_HANDOFF'
      and coalesce(v_alert.metadata->>'action_type','')='SCHEDULE_MEETING')
     or (v_alert.alert_type='ONBOARDING_GT_ASSIGNMENT_REQUIRED'
      and coalesce(v_alert.metadata->>'action_type','')='ASSIGN_GT') then
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

  if v_alert.alert_type='ONBOARDING_MEETING_COMPLETION_CHECK'
     and coalesce(v_alert.metadata->>'action_type','')='CONFIRM_MEETING_OUTCOME' then
    v_next_present_at := v_now + interval '1 hour';
    v_snooze_count := coalesce((v_alert.metadata->>'snooze_count')::integer,0)+1;
    update agency_ops.onboarding_required_alerts
    set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
      'ack_action','SNOOZE_1H',
      'last_acknowledged_person',p_person,
      'last_acknowledged_by_user_key',p_user_key,
      'last_snoozed_at',v_now,
      'next_present_at',v_next_present_at,
      'snooze_count',v_snooze_count
    )
    where id=v_alert.id;
    return jsonb_build_object('ok',true,'id',v_alert.id,'action','SNOOZE_1H','next_present_at',v_next_present_at);
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
$function$

CREATE OR REPLACE FUNCTION agency_ops.sync_onboarding_meeting_guardrails()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agency_ops', 'public', 'pg_catalog'
AS $function$
declare
  r record;
  m record;
  v_stage text;
  v_target_person text;
  v_target_role text;
  v_client_name text;
  v_gt text;
  v_prev_done boolean;
  v_due timestamptz;
  v_msg_at timestamptz;
  v_msg_id bigint;
  v_msg_body text;
  v_dt timestamptz;
  v_alert_id uuid;
  v_created int:=0;
  v_completed int:=0;
  v_scheduled int:=0;
  v_presence_updates int:=0;
  v_previous_internal text:=coalesce(current_setting('agency_ops.onboarding_internal_update',true),'off');
begin
  perform set_config('agency_ops.onboarding_internal_update','on',true);

  -- Strongest explicit source first: a human statement that a specific onboarding meeting was completed.
  -- This is allowed to upgrade SKIPPED back to DONE because SKIPPED is only an inference, while the message is direct evidence.
  for r in
    select oc.id as case_id,oc.client_id,oc.opened_at,c.display_name,c.gt_owner,
           s.stage_code,s.status
    from agency_ops.onboarding_cases oc
    join agency_ops.clients c on c.id=oc.client_id
    join agency_ops.onboarding_stages s on s.case_id=oc.id
    where oc.status='OPEN' and c.lifecycle='ONBOARDING'
      and s.stage_code in ('INTRO_MEETING','PRODUCT_PERSONA_MEETING','INTEGRATION_MEETING')
      and s.status <> 'DONE'
  loop
    v_msg_at:=null; v_msg_id:=null; v_msg_body:=null;

    select wm.event_at,wm.id,coalesce(nullif(wm.text_body,''),wm.caption,'')
      into v_msg_at,v_msg_id,v_msg_body
    from agency_ops.client_integrations ci
    join agency_ops.whatsapp_messages wm on wm.chat_id=ci.external_id
    where ci.client_id=r.client_id
      and ci.system='WHATSAPP_GROUP'
      and wm.event_at>=r.opened_at
      and (
        (r.stage_code='INTRO_MEETING' and (
          coalesce(wm.text_body,wm.caption,'') ~* '(reuni.{0,2}o|call).{0,80}(onboarding|apresenta.{0,2}o).{0,80}(finaliz|realizad|conclu|feita|feito)'
          or coalesce(wm.text_body,wm.caption,'') ~* '(finaliz|realizad|conclu|feita|feito).{0,80}(reuni.{0,2}o|call).{0,80}(onboarding|apresenta.{0,2}o)'
        ))
        or
        (r.stage_code='PRODUCT_PERSONA_MEETING' and (
          coalesce(wm.text_body,wm.caption,'') ~* '(reuni.{0,2}o|call).{0,80}(briefing|produto.{0,40}persona|persona.{0,40}produto).{0,80}(finaliz|realizad|conclu|feita|feito)'
          or coalesce(wm.text_body,wm.caption,'') ~* '(finaliz|realizad|conclu|feita|feito).{0,80}(reuni.{0,2}o|call).{0,80}(briefing|produto.{0,40}persona|persona.{0,40}produto)'
        ))
        or
        (r.stage_code='INTEGRATION_MEETING' and (
          coalesce(wm.text_body,wm.caption,'') ~* '(reuni.{0,2}o|call).{0,80}(integra.{0,3}o).{0,80}(finaliz|realizad|conclu|feita|feito)'
          or coalesce(wm.text_body,wm.caption,'') ~* '(finaliz|realizad|conclu|feita|feito).{0,80}(reuni.{0,2}o|call).{0,80}(integra.{0,3}o)'
        ))
      )
    order by wm.event_at desc
    limit 1;

    if v_msg_at is not null then
      update agency_ops.onboarding_stages
      set status='DONE',
          started_at=coalesce(started_at,v_msg_at),
          completed_at=coalesce(completed_at,v_msg_at),
          due_at=coalesce(due_at,v_msg_at),
          blocked_type=null,
          notes=case
            when coalesce(notes,'') ilike '%Conclusão explícita detectada no WhatsApp [mensagem '||v_msg_id||']%' then notes
            else concat_ws(' | ',nullif(notes,''),'Conclusão explícita detectada no WhatsApp [mensagem '||v_msg_id||']')
          end
      where case_id=r.case_id and stage_code=r.stage_code and status<>'DONE';
      if found then
        v_completed:=v_completed+1;
        insert into agency_ops.onboarding_events(case_id,event_type,source,source_id,occurred_at,metadata)
        select r.case_id,'MEETING_COMPLETED','whatsapp_guardrail',v_msg_id::text,v_msg_at,
               jsonb_build_object('stage_code',r.stage_code,'evidence_text',left(v_msg_body,700))
        where not exists(
          select 1 from agency_ops.onboarding_events e
          where e.source='whatsapp_guardrail' and e.source_id=v_msg_id::text and e.event_type='MEETING_COMPLETED'
        );
      end if;
    end if;
  end loop;

  -- Meeting presence is also strong evidence because the three onboarding meetings have fixed internal owners.
  for m in
    select mpe.*,oc.id as case_id,c.gt_owner,
           coalesce(tr.role,'') as person_role
    from agency_ops.meeting_presence_events mpe
    join agency_ops.onboarding_cases oc on oc.client_id=mpe.client_id and oc.status='OPEN'
    join agency_ops.clients c on c.id=oc.client_id and c.lifecycle='ONBOARDING'
    left join agency_ops.team_roster tr on tr.person=mpe.person and coalesce(tr.is_former,false)=false
    where mpe.started_at>=oc.opened_at
      and mpe.started_at>=now()-interval '45 days'
      and (
        mpe.person in ('Joel Antoniete','Gustavo Lima')
        or upper(coalesce(tr.role,''))='GT'
      )
    order by mpe.started_at
  loop
    v_stage:=case
      when m.person='Joel Antoniete' then 'INTRO_MEETING'
      when m.person='Gustavo Lima' then 'PRODUCT_PERSONA_MEETING'
      when upper(coalesce(m.person_role,''))='GT'
        and exists(select 1 from agency_ops.onboarding_stages s where s.case_id=m.case_id and s.stage_code='PRODUCT_PERSONA_MEETING' and s.status='DONE')
        then 'INTEGRATION_MEETING'
      else null
    end;
    if v_stage is null then continue; end if;

    if m.transcript_id is not null or m.status in ('COMPLETED','CONTEXT_AVAILABLE') then
      update agency_ops.onboarding_stages
      set status='DONE',
          started_at=coalesce(started_at,m.started_at),
          completed_at=coalesce(completed_at,m.ended_at,m.started_at),
          due_at=coalesce(due_at,m.started_at),
          blocked_type=null,
          notes=case
            when coalesce(notes,'') ilike '%Meeting Radar%' then notes
            else concat_ws(' | ',nullif(notes,''),'Reunião confirmada pelo Meeting Radar com '||m.person||' ['||m.id||']')
          end
      where case_id=m.case_id and stage_code=v_stage and status<>'DONE';
      if found then v_presence_updates:=v_presence_updates+1; v_completed:=v_completed+1; end if;
    elsif m.status in ('IN_PROGRESS','DETECTED') then
      update agency_ops.onboarding_stages
      set status=case when status in ('PENDING','MENTIONED','SCHEDULED') then 'IN_PROGRESS' else status end,
          started_at=coalesce(started_at,m.started_at),
          due_at=coalesce(due_at,m.started_at),
          notes=case
            when coalesce(notes,'') ilike '%Meeting Radar%' then notes
            else concat_ws(' | ',nullif(notes,''),'Reunião iniciada detectada pelo Meeting Radar com '||m.person||' ['||m.id||']')
          end
      where case_id=m.case_id and stage_code=v_stage and status not in ('DONE','SKIPPED');
      if found then v_presence_updates:=v_presence_updates+1; end if;
    end if;
  end loop;

  -- Conservative automatic schedule detection: explicit meeting type + confirmation + parseable date/time only.
  for r in
    select oc.id as case_id,oc.client_id,oc.opened_at,c.display_name,
           s.stage_code,s.status,s.due_at
    from agency_ops.onboarding_cases oc
    join agency_ops.clients c on c.id=oc.client_id
    join agency_ops.onboarding_stages s on s.case_id=oc.id
    where oc.status='OPEN' and c.lifecycle='ONBOARDING'
      and s.stage_code in ('INTRO_MEETING','PRODUCT_PERSONA_MEETING','INTEGRATION_MEETING')
      and s.status in ('PENDING','MENTIONED')
      and s.due_at is null
  loop
    v_prev_done:=case
      when r.stage_code='INTRO_MEETING' then exists(select 1 from agency_ops.onboarding_stages x where x.case_id=r.case_id and x.stage_code='OPERATIONAL_ACTIVATION' and x.status='DONE')
      when r.stage_code='PRODUCT_PERSONA_MEETING' then exists(select 1 from agency_ops.onboarding_stages x where x.case_id=r.case_id and x.stage_code='INTRO_MEETING' and x.status='DONE')
      else exists(select 1 from agency_ops.onboarding_stages x where x.case_id=r.case_id and x.stage_code='PRODUCT_PERSONA_MEETING' and x.status='DONE')
    end;
    if not v_prev_done then continue; end if;

    v_msg_at:=null; v_msg_id:=null; v_msg_body:=null; v_dt:=null;
    select wm.event_at,wm.id,coalesce(nullif(wm.text_body,''),wm.caption,'')
      into v_msg_at,v_msg_id,v_msg_body
    from agency_ops.client_integrations ci
    join agency_ops.whatsapp_messages wm on wm.chat_id=ci.external_id
    where ci.client_id=r.client_id and ci.system='WHATSAPP_GROUP' and wm.event_at>=r.opened_at
      and coalesce(wm.text_body,wm.caption,'') ~* '(combinad|confirmad|marcad|agendad|nos vemos|vamos realizar|iremos realizar)'
      and (
        (r.stage_code='INTRO_MEETING' and coalesce(wm.text_body,wm.caption,'') ~* '(onboarding|apresenta.{0,2}o)')
        or (r.stage_code='PRODUCT_PERSONA_MEETING' and coalesce(wm.text_body,wm.caption,'') ~* '(briefing|produto.{0,40}persona|persona.{0,40}produto)')
        or (r.stage_code='INTEGRATION_MEETING' and coalesce(wm.text_body,wm.caption,'') ~* 'integra.{0,3}o')
      )
    order by wm.event_at desc
    limit 1;

    if v_msg_at is not null then
      v_dt:=agency_ops.extract_ptbr_meeting_datetime(v_msg_body,v_msg_at);
      if v_dt is not null then
        update agency_ops.onboarding_stages
        set status='SCHEDULED',started_at=coalesce(started_at,v_msg_at),due_at=v_dt,
            notes=concat_ws(' | ',nullif(notes,''),'Agendamento explícito detectado no WhatsApp [mensagem '||v_msg_id||']')
        where case_id=r.case_id and stage_code=r.stage_code and status in ('PENDING','MENTIONED');
        if found then v_scheduled:=v_scheduled+1; end if;
      end if;
    end if;
  end loop;

  for r in
    select oc.id
    from agency_ops.onboarding_cases oc
    join agency_ops.clients c on c.id=oc.client_id
    where oc.status='OPEN' and c.lifecycle='ONBOARDING'
  loop
    perform agency_ops.recalculate_onboarding_case(r.id);
  end loop;

  for r in
    select oc.id as case_id,oc.client_id,oc.opened_at,c.display_name,c.gt_owner,
           s.stage_code,s.status,s.due_at,s.completed_at
    from agency_ops.onboarding_cases oc
    join agency_ops.clients c on c.id=oc.client_id
    join agency_ops.onboarding_stages s on s.case_id=oc.id
    where oc.status='OPEN' and c.lifecycle='ONBOARDING'
      and s.stage_code in ('INTRO_MEETING','PRODUCT_PERSONA_MEETING','INTEGRATION_MEETING')
      and s.status not in ('DONE','SKIPPED')
  loop
    v_client_name:=r.display_name;
    v_gt:=nullif(btrim(coalesce(r.gt_owner,'')),'');
    v_prev_done:=case
      when r.stage_code='INTRO_MEETING' then exists(select 1 from agency_ops.onboarding_stages x where x.case_id=r.case_id and x.stage_code='OPERATIONAL_ACTIVATION' and x.status='DONE')
      when r.stage_code='PRODUCT_PERSONA_MEETING' then exists(select 1 from agency_ops.onboarding_stages x where x.case_id=r.case_id and x.stage_code='INTRO_MEETING' and x.status='DONE')
      else exists(select 1 from agency_ops.onboarding_stages x where x.case_id=r.case_id and x.stage_code='PRODUCT_PERSONA_MEETING' and x.status='DONE')
    end;
    if not v_prev_done then continue; end if;

    if r.stage_code='INTRO_MEETING' then
      v_target_person:='Joel Antoniete'; v_target_role:='CS';
    elsif r.stage_code='PRODUCT_PERSONA_MEETING' then
      v_target_person:='Gustavo Lima'; v_target_role:='CS';
    else
      v_target_person:=v_gt;
      v_target_role:='GT';

      if v_target_person is null then
        select mpe.person into v_target_person
        from agency_ops.meeting_presence_events mpe
        join agency_ops.team_roster tr on tr.person=mpe.person and coalesce(tr.is_former,false)=false and upper(coalesce(tr.role,''))='GT'
        where mpe.client_id=r.client_id and mpe.started_at>=r.opened_at
        order by mpe.started_at desc
        limit 1;

        v_alert_id:=agency_ops.enqueue_onboarding_required_alert(
          'onboarding:gt-required:'||r.case_id::text,
          'ONBOARDING_GT_ASSIGNMENT_REQUIRED',
          r.client_id,r.case_id,'Joel Antoniete','CS',
          'Definir GT do onboarding — '||v_client_name,
          v_client_name||' chegou à integração e ainda não possui GT confirmado na carteira. Defina o GT responsável para que a cobrança da reunião fique vinculada corretamente.',
          'onboarding_meeting_guardrail',
          'Ainda sem GT',
          jsonb_build_object('target_stage','INTEGRATION_MEETING','action_type','ASSIGN_GT','decision_mode','HUMAN_ACTION_REQUIRED')
        );
        if v_alert_id is not null then v_created:=v_created+1; end if;

        if v_target_person is null then continue; end if;
      else
        update agency_ops.onboarding_required_alerts
        set acknowledged_at=coalesce(acknowledged_at,now()),
            acknowledged_by_user_key=coalesce(acknowledged_by_user_key,'AUTO:GT_DEFINED'),
            metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('auto_resolved',true,'resolution_source','GT_DEFINED','resolution_at',now(),'next_present_at',null)
        where onboarding_case_id=r.case_id and alert_type='ONBOARDING_GT_ASSIGNMENT_REQUIRED' and acknowledged_at is null;
      end if;
    end if;

    if r.status in ('PENDING','MENTIONED') and r.due_at is null then
      v_alert_id:=agency_ops.maybe_enqueue_onboarding_meeting_handoff(
        r.case_id,r.stage_code,v_target_person,
        case r.stage_code when 'INTRO_MEETING' then 'OPERATIONAL_ACTIVATION'
                          when 'PRODUCT_PERSONA_MEETING' then 'INTRO_MEETING'
                          else 'PRODUCT_PERSONA_MEETING' end
      );
      if v_alert_id is not null then v_created:=v_created+1; end if;
      continue;
    end if;

    v_due:=r.due_at;
    if v_due is null then
      select ml.scheduled_for into v_due
      from agency_ops.onboarding_stage_meet_links ml
      where ml.case_id=r.case_id and ml.stage_code=r.stage_code and ml.is_current and ml.scheduled_for is not null
      order by ml.updated_at desc limit 1;
    end if;
    if v_due is null then continue; end if;

    v_alert_id:=agency_ops.enqueue_onboarding_required_alert(
      'onboarding:meeting-scheduled-info:'||r.case_id::text||':'||r.stage_code||':'||to_char(v_due,'YYYYMMDDHH24MI'),
      'ONBOARDING_MEETING_SCHEDULED_INFO',
      r.client_id,r.case_id,v_target_person,v_target_role,
      'Reunião marcada — '||v_client_name,
      (case r.stage_code when 'INTRO_MEETING' then '1ª reunião de apresentação'
                         when 'PRODUCT_PERSONA_MEETING' then 'Reunião de Produto + Persona'
                         else 'Reunião de integração' end)
        ||' de '||v_client_name||' está registrada para '||
        to_char(v_due at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')||'. Confirme ciência.',
      'onboarding_meeting_guardrail','Ciente',
      jsonb_build_object('target_stage',r.stage_code,'action_type','ACK_MEETING_SCHEDULED','scheduled_for',v_due)
    );
    if v_alert_id is not null then v_created:=v_created+1; end if;

    if (v_due at time zone 'America/Sao_Paulo')::date=(now() at time zone 'America/Sao_Paulo')::date
       and (now() at time zone 'America/Sao_Paulo')::time>=time '08:00'
       and v_due>now()+interval '75 minutes' then
      v_alert_id:=agency_ops.enqueue_onboarding_required_alert(
        'onboarding:meeting-day:'||r.case_id::text||':'||r.stage_code||':'||to_char(v_due,'YYYYMMDD'),
        'ONBOARDING_MEETING_DAY_REMINDER',
        r.client_id,r.case_id,v_target_person,v_target_role,
        'Reunião hoje — '||v_client_name,
        'Hoje você tem '||
          (case r.stage_code when 'INTRO_MEETING' then 'a 1ª reunião de apresentação'
                             when 'PRODUCT_PERSONA_MEETING' then 'a reunião de Produto + Persona'
                             else 'a reunião de integração' end)
          ||' com '||v_client_name||' às '||to_char(v_due at time zone 'America/Sao_Paulo','HH24:MI')||'. Confirme ciência.',
        'onboarding_meeting_guardrail','Ciente',
        jsonb_build_object('target_stage',r.stage_code,'action_type','ACK_DAY_REMINDER','scheduled_for',v_due)
      );
      if v_alert_id is not null then v_created:=v_created+1; end if;
    end if;

    if v_due>now() and v_due<=now()+interval '60 minutes' then
      v_alert_id:=agency_ops.enqueue_onboarding_required_alert(
        'onboarding:meeting-60m:'||r.case_id::text||':'||r.stage_code||':'||to_char(v_due,'YYYYMMDDHH24MI'),
        'ONBOARDING_MEETING_60M_REMINDER',
        r.client_id,r.case_id,v_target_person,v_target_role,
        'Reunião em até 1 hora — '||v_client_name,
        'Não esqueça: '||
          (case r.stage_code when 'INTRO_MEETING' then '1ª reunião de apresentação'
                             when 'PRODUCT_PERSONA_MEETING' then 'Produto + Persona'
                             else 'integração' end)
          ||' com '||v_client_name||' às '||to_char(v_due at time zone 'America/Sao_Paulo','HH24:MI')||'.',
        'onboarding_meeting_guardrail','Ciente',
        jsonb_build_object('target_stage',r.stage_code,'action_type','ACK_60M_REMINDER','scheduled_for',v_due)
      );
      if v_alert_id is not null then v_created:=v_created+1; end if;
    end if;

    if v_due<now()-interval '75 minutes' then
      v_alert_id:=agency_ops.enqueue_onboarding_required_alert(
        'onboarding:meeting-completion-check:'||r.case_id::text||':'||r.stage_code||':'||to_char(v_due,'YYYYMMDDHH24MI'),
        'ONBOARDING_MEETING_COMPLETION_CHECK',
        r.client_id,r.case_id,v_target_person,v_target_role,
        'Confirmar realização da reunião — '||v_client_name,
        'A reunião estava registrada para '||to_char(v_due at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')||
          ' e ainda não encontramos confirmação conclusiva. Informe se ela foi realizada ou se foi reagendada.',
        'onboarding_meeting_guardrail','Ainda não confirmei',
        jsonb_build_object('target_stage',r.stage_code,'action_type','CONFIRM_MEETING_OUTCOME','scheduled_for',v_due)
      );
      if v_alert_id is not null then v_created:=v_created+1; end if;
    end if;
  end loop;

  -- Expired informational/reminder alerts must not block the completion check.
  update agency_ops.onboarding_required_alerts
  set acknowledged_at=coalesce(acknowledged_at,now()),
      acknowledged_by_user_key=coalesce(acknowledged_by_user_key,'AUTO:MEETING_TIME_PASSED'),
      metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
        'auto_resolved',true,
        'resolution_source','MEETING_TIME_PASSED',
        'resolution_at',now(),
        'next_present_at',null
      )
  where acknowledged_at is null
    and alert_type in ('ONBOARDING_MEETING_SCHEDULED_INFO','ONBOARDING_MEETING_DAY_REMINDER','ONBOARDING_MEETING_60M_REMINDER')
    and nullif(metadata->>'scheduled_for','') is not null
    and (metadata->>'scheduled_for')::timestamptz <= now();

  -- If a meeting was detected/scheduled automatically, remove the older scheduling prompt.
  update agency_ops.onboarding_required_alerts a
  set acknowledged_at=coalesce(a.acknowledged_at,now()),
      acknowledged_by_user_key=coalesce(a.acknowledged_by_user_key,'AUTO:MEETING_ALREADY_SCHEDULED'),
      metadata=coalesce(a.metadata,'{}'::jsonb)||jsonb_build_object(
        'auto_resolved',true,
        'resolution_source','MEETING_ALREADY_SCHEDULED',
        'resolution_at',now(),
        'next_present_at',null
      )
  where a.acknowledged_at is null
    and a.alert_type='ONBOARDING_MEETING_HANDOFF'
    and exists(
      select 1
      from agency_ops.onboarding_stages s
      where s.case_id=a.onboarding_case_id
        and s.stage_code=a.metadata->>'target_stage'
        and (s.status in ('SCHEDULED','IN_PROGRESS','DONE','SKIPPED') or s.due_at is not null)
    );

  perform agency_ops.run_onboarding_notification_engine();
  perform set_config('agency_ops.onboarding_internal_update',v_previous_internal,true);

  return jsonb_build_object(
    'created_alerts',v_created,
    'completed_updates',v_completed,
    'scheduled_updates',v_scheduled,
    'presence_updates',v_presence_updates,
    'ran_at',now()
  );
exception when others then
  perform set_config('agency_ops.onboarding_internal_update',v_previous_internal,true);
  raise;
end;
$function$

CREATE OR REPLACE FUNCTION agency_ops.tg_normalize_onboarding_meeting_topic()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agency_ops', 'public', 'pg_catalog'
AS $function$
declare
  v_case_id bigint;
  v_role text;
  v_pp_done boolean:=false;
begin
  if new.client_id is null or nullif(btrim(coalesce(new.person,'')),'') is null then return new; end if;

  select oc.id into v_case_id
  from agency_ops.onboarding_cases oc
  join agency_ops.clients c on c.id=oc.client_id
  where oc.client_id=new.client_id and oc.status='OPEN' and c.lifecycle='ONBOARDING'
  order by oc.opened_at desc
  limit 1;

  if v_case_id is null then return new; end if;

  if new.person='Joel Antoniete' then
    new.topic:='1ª reunião de apresentação';
  elsif new.person='Gustavo Lima' then
    new.topic:='Produto + Persona';
  else
    select tr.role into v_role
    from agency_ops.team_roster tr
    where tr.person=new.person and coalesce(tr.is_former,false)=false
    limit 1;

    select exists(
      select 1 from agency_ops.onboarding_stages s
      where s.case_id=v_case_id and s.stage_code='PRODUCT_PERSONA_MEETING' and s.status='DONE'
    ) into v_pp_done;

    if upper(coalesce(v_role,''))='GT' and v_pp_done then
      new.topic:='Integração GT';
    end if;
  end if;
  return new;
end;
$function$

CREATE OR REPLACE FUNCTION agency_ops.tg_onboarding_meeting_stage_alert_cleanup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agency_ops', 'public', 'pg_catalog'
AS $function$
begin
  if tg_op='UPDATE'
     and new.status is distinct from old.status
     and new.status in ('DONE','SKIPPED') then
    update agency_ops.onboarding_required_alerts
    set acknowledged_at=coalesce(acknowledged_at,now()),
        acknowledged_by_user_key=coalesce(acknowledged_by_user_key,'AUTO:MEETING_STAGE_RESOLVED'),
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'auto_resolved',true,
          'resolution_source','MEETING_STAGE_RESOLVED',
          'resolution_stage_status',new.status,
          'resolution_at',now(),
          'next_present_at',null
        )
    where onboarding_case_id=new.case_id
      and acknowledged_at is null
      and metadata->>'target_stage'=new.stage_code;
  end if;
  return new;
end;
$function$


drop trigger if exists trg_onboarding_meeting_stage_alert_cleanup on agency_ops.onboarding_stages;
create trigger trg_onboarding_meeting_stage_alert_cleanup
after update of status on agency_ops.onboarding_stages
for each row execute function agency_ops.tg_onboarding_meeting_stage_alert_cleanup();

drop trigger if exists trg_normalize_onboarding_meeting_topic on agency_ops.meeting_presence_events;
create trigger trg_normalize_onboarding_meeting_topic
before insert or update of person,client_id,topic,status,transcript_id
on agency_ops.meeting_presence_events
for each row execute function agency_ops.tg_normalize_onboarding_meeting_topic();

update agency_ops.worker_runtime_config
set value=jsonb_set(coalesce(value,'{}'::jsonb),'{interval_ms}','300000'::jsonb,true),
    updated_at=now()
where key='onboarding_consolidated';

do $do$
declare j record;
begin
  for j in select jobid from cron.job where jobname='onboarding-meeting-guardrails' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule(
    'onboarding-meeting-guardrails',
    '*/2 * * * *',
    'select agency_ops.sync_onboarding_meeting_guardrails();'
  );
end
$do$;

select agency_ops.sync_onboarding_meeting_guardrails();

update agency_ops.meeting_presence_events mpe
set topic=mpe.topic
where mpe.client_id is not null
  and exists(
    select 1
    from agency_ops.onboarding_cases oc
    join agency_ops.clients c on c.id=oc.client_id
    where oc.client_id=mpe.client_id
      and oc.status='OPEN'
      and c.lifecycle='ONBOARDING'
  );
