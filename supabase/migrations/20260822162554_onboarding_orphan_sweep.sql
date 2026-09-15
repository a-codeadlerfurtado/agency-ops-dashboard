create or replace function agency_ops.sweep_onboarding_orphans()
returns jsonb
language plpgsql
security definer
set search_path='agency_ops','public','pg_catalog'
as $function$
declare
  r record;
  v_case_id bigint;
  v_target_person text;
  v_target_role text;
  v_title text;
  v_description text;
  v_alert_id uuid;
  v_occurrence integer;
  v_created_cases integer := 0;
  v_repaired_cases integer := 0;
  v_missing_meeting_alerts integer := 0;
  v_auto_resolved_alerts integer := 0;
  v_previous_internal text := coalesce(current_setting('agency_ops.onboarding_internal_update',true),'off');
begin
  perform set_config('agency_ops.onboarding_internal_update','on',true);

  for r in
    select c.*
    from agency_ops.clients c
    where c.lifecycle='ONBOARDING'
      and not exists (
        select 1 from agency_ops.onboarding_cases oc
        where oc.client_id=c.id and oc.status='OPEN'
      )
  loop
    insert into agency_ops.onboarding_cases(
      client_id,opened_at,status,current_stage,onboarding_risk,metadata
    ) values (
      r.id,
      coalesce((r.entrada::timestamp at time zone 'America/Sao_Paulo'),now()),
      'OPEN','SALES_CONFIRMED','ATTENTION',
      jsonb_build_object(
        'created_from','ONBOARDING_ORPHAN_SWEEP',
        'orphan_sweep_attention',true,
        'orphan_reason','MISSING_OPEN_CASE',
        'orphan_detected_at',now()
      )
    ) returning id into v_case_id;

    insert into agency_ops.onboarding_stages(case_id,stage_code,status,completed_at,notes)
    select v_case_id,d.code,
           case when d.code='SALES_CONFIRMED' then 'DONE' else 'PENDING' end,
           case when d.code='SALES_CONFIRMED' then now() else null end,
           case when d.code='SALES_CONFIRMED' then 'Reconstruída pelo sweep de integridade do onboarding' else null end
    from agency_ops.onboarding_stage_definitions d
    on conflict(case_id,stage_code) do nothing;

    if exists(
      select 1 from agency_ops.client_integrations ci
      where ci.client_id=r.id and ci.system='WHATSAPP_GROUP'
    ) then
      update agency_ops.onboarding_stages
      set status='DONE',completed_at=coalesce(completed_at,now()),blocked_type=null,
          notes=concat_ws(' | ',nullif(notes,''),'Grupo operacional já vinculado; confirmado pelo sweep de integridade')
      where case_id=v_case_id and stage_code='OPERATIONAL_ACTIVATION';
    end if;

    insert into agency_ops.onboarding_requirements(case_id,requirement)
    values (v_case_id,'META_ACCESS'),(v_case_id,'CRM_ACCESS'),(v_case_id,'GOOGLE_ACCESS')
    on conflict(case_id,requirement) do nothing;

    perform agency_ops.recalculate_onboarding_case(v_case_id);
    v_created_cases := v_created_cases + 1;
  end loop;

  for r in
    select oc.id
    from agency_ops.onboarding_cases oc
    where oc.status='OPEN'
      and (
        oc.current_stage is null
        or not exists(
          select 1 from agency_ops.onboarding_stages s
          where s.case_id=oc.id and s.stage_code=oc.current_stage
        )
      )
  loop
    perform agency_ops.recalculate_onboarding_case(r.id);
    v_repaired_cases := v_repaired_cases + 1;
  end loop;

  for r in
    select a.id,a.onboarding_case_id,a.metadata->>'target_stage' as target_stage
    from agency_ops.onboarding_required_alerts a
    left join agency_ops.onboarding_cases oc on oc.id=a.onboarding_case_id
    left join agency_ops.onboarding_stages s
      on s.case_id=a.onboarding_case_id and s.stage_code=a.metadata->>'target_stage'
    where a.acknowledged_at is null
      and a.alert_type='ONBOARDING_MEETING_HANDOFF'
      and coalesce(a.metadata->>'action_type','')='SCHEDULE_MEETING'
      and (
        coalesce(oc.status,'') <> 'OPEN'
        or s.status in ('SCHEDULED','DONE','SKIPPED')
        or s.due_at is not null
        or exists(
          select 1 from agency_ops.onboarding_stage_meet_links ml
          where ml.case_id=a.onboarding_case_id
            and ml.stage_code=a.metadata->>'target_stage'
            and ml.is_current
            and ml.scheduled_for is not null
        )
      )
  loop
    update agency_ops.onboarding_required_alerts
    set acknowledged_at=now(),
        acknowledged_by_user_key='AUTO:ONBOARDING_ORPHAN_SWEEP',
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'auto_resolved',true,
          'resolution_source','ONBOARDING_ORPHAN_SWEEP',
          'resolution_reason','A reunião deixou de estar sem agendamento ou a etapa/case avançou.',
          'resolution_at',now()
        )
    where id=r.id and acknowledged_at is null;

    if found then
      insert into agency_ops.onboarding_events(case_id,event_type,source,source_id,occurred_at,metadata)
      select r.onboarding_case_id,'REQUIRED_ALERT_AUTO_RESOLVED','onboarding_orphan_sweep',r.id::text,now(),
             jsonb_build_object('target_stage',r.target_stage,'reason','MEETING_ALREADY_SCHEDULED_OR_STAGE_ADVANCED')
      where r.onboarding_case_id is not null
        and not exists(
          select 1 from agency_ops.onboarding_events e
          where e.source='onboarding_orphan_sweep'
            and e.source_id=r.id::text
            and e.event_type='REQUIRED_ALERT_AUTO_RESOLVED'
        );
      v_auto_resolved_alerts := v_auto_resolved_alerts + 1;
    end if;
  end loop;

  for r in
    select oc.id as case_id,oc.client_id,c.display_name,c.gt_owner,
           s.stage_code,s.status,s.due_at
    from agency_ops.onboarding_cases oc
    join agency_ops.clients c on c.id=oc.client_id
    join agency_ops.onboarding_stages s on s.case_id=oc.id and s.stage_code=oc.current_stage
    where oc.status='OPEN'
      and c.lifecycle='ONBOARDING'
      and s.stage_code in ('INTRO_MEETING','PRODUCT_PERSONA_MEETING','INTEGRATION_MEETING')
      and s.status in ('PENDING','MENTIONED')
      and s.due_at is null
      and not exists(
        select 1 from agency_ops.onboarding_stage_meet_links ml
        where ml.case_id=oc.id and ml.stage_code=s.stage_code and ml.is_current
          and ml.scheduled_for is not null
      )
  loop
    if r.stage_code='INTRO_MEETING' then
      v_target_person := 'Joel Antoniete';
      v_target_role := 'CS';
      v_title := 'Onboarding sem 1ª reunião marcada — '||r.display_name;
      v_description := r.display_name||' está em onboarding e ainda não possui data/hora para a 1ª reunião de apresentação. Marque a reunião para o cliente não ficar solto.';
    elsif r.stage_code='PRODUCT_PERSONA_MEETING' then
      v_target_person := 'Gustavo Lima';
      v_target_role := 'CS';
      v_title := 'Produto + Persona sem reunião marcada — '||r.display_name;
      v_description := r.display_name||' chegou à etapa Produto + Persona e ainda não possui data/hora marcada. Agende a reunião para o onboarding continuar.';
    else
      v_target_person := coalesce(nullif(btrim(r.gt_owner),''),'Adler Furtado');
      v_target_role := case when nullif(btrim(r.gt_owner),'') is null then 'MGMT' else 'GT' end;
      v_title := 'Integração sem reunião marcada — '||r.display_name;
      v_description := case when nullif(btrim(r.gt_owner),'') is null
        then r.display_name||' chegou à integração sem GT definido e sem reunião marcada. Defina o GT e organize a integração.'
        else r.display_name||' chegou à integração com '||r.gt_owner||' e ainda não possui data/hora marcada. Agende a integração.' end;
    end if;

    if not exists(
      select 1 from agency_ops.onboarding_required_alerts a
      where a.onboarding_case_id=r.case_id
        and a.alert_type='ONBOARDING_MEETING_HANDOFF'
        and a.acknowledged_at is null
        and a.metadata->>'target_stage'=r.stage_code
    ) then
      select count(*)+1 into v_occurrence
      from agency_ops.onboarding_required_alerts a
      where a.onboarding_case_id=r.case_id
        and a.alert_type='ONBOARDING_MEETING_HANDOFF'
        and a.metadata->>'target_stage'=r.stage_code;

      v_alert_id := agency_ops.enqueue_onboarding_required_alert(
        'onboarding:orphan:'||r.case_id::text||':'||r.stage_code||':'||v_occurrence::text,
        'ONBOARDING_MEETING_HANDOFF',
        r.client_id,
        r.case_id,
        v_target_person,
        v_target_role,
        v_title,
        v_description,
        'onboarding_orphan_sweep',
        'Ciente, vou resolver',
        jsonb_build_object(
          'target_stage',r.stage_code,
          'action_type','SCHEDULE_MEETING',
          'decision_mode','HUMAN_ACTION_REQUIRED',
          'orphan_sweep',true,
          'occurrence',v_occurrence,
          'detected_at',now()
        )
      );
      if v_alert_id is not null then
        v_missing_meeting_alerts := v_missing_meeting_alerts + 1;
      end if;
    end if;

    update agency_ops.onboarding_cases
    set onboarding_risk=case when onboarding_risk in ('HIGH','CRITICAL') then onboarding_risk else 'ATTENTION' end,
        metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
          'orphan_sweep_attention',true,
          'orphan_reason','MEETING_NOT_SCHEDULED',
          'orphan_stage',r.stage_code,
          'orphan_detected_at',now()
        ),
        updated_at=now()
    where id=r.case_id;
  end loop;

  update agency_ops.onboarding_cases oc
  set onboarding_risk='OK',
      metadata=(coalesce(oc.metadata,'{}'::jsonb) - 'orphan_sweep_attention' - 'orphan_reason' - 'orphan_stage' - 'orphan_detected_at')
        || jsonb_build_object('orphan_resolved_at',now()),
      updated_at=now()
  where oc.status='OPEN'
    and oc.onboarding_risk='ATTENTION'
    and coalesce((oc.metadata->>'orphan_sweep_attention')::boolean,false)
    and not exists(
      select 1
      from agency_ops.onboarding_stages s
      where s.case_id=oc.id
        and s.stage_code=oc.current_stage
        and s.stage_code in ('INTRO_MEETING','PRODUCT_PERSONA_MEETING','INTEGRATION_MEETING')
        and s.status in ('PENDING','MENTIONED')
        and s.due_at is null
        and not exists(
          select 1 from agency_ops.onboarding_stage_meet_links ml
          where ml.case_id=oc.id and ml.stage_code=s.stage_code and ml.is_current
            and ml.scheduled_for is not null
        )
    );

  perform set_config('agency_ops.onboarding_internal_update',v_previous_internal,true);

  return jsonb_build_object(
    'created_cases',v_created_cases,
    'repaired_cases',v_repaired_cases,
    'missing_meeting_alerts',v_missing_meeting_alerts,
    'auto_resolved_alerts',v_auto_resolved_alerts,
    'ran_at',now()
  );
exception when others then
  perform set_config('agency_ops.onboarding_internal_update',v_previous_internal,true);
  raise;
end;
$function$;

do $do$
declare j record;
begin
  for j in select jobid from cron.job where jobname='onboarding-orphan-sweep' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule(
    'onboarding-orphan-sweep',
    '*/2 * * * *',
    'select agency_ops.sweep_onboarding_orphans();'
  );
end
$do$;
