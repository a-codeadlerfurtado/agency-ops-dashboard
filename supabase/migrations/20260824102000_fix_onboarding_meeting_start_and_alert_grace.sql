-- Reuniões de onboarding usam due_at como horário de INÍCIO, não como SLA de conclusão.
-- 1) Meet de integração enviado no horário da reunião inicia a etapa automaticamente.
-- 2) Reuniões ganham janela padrão de 60 min + 15 min de tolerância antes de pedir confirmação de conclusão.
-- 3) O alerta genérico de atraso não duplica o alerta específico de reunião.

create or replace function agency_ops.capture_integration_meet_link_from_whatsapp()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog','extensions'
as $$
declare
  v_text text;
  v_norm text;
  v_url text;
  v_case_id bigint;
  v_current_stage text;
  v_stage_status text;
  v_due_at timestamptz;
  v_gt_owner text;
  v_occurred_at timestamptz;
  v_explicit_dt timestamptz;
  v_is_current boolean;
  v_context_ok boolean;
  v_started boolean := false;
begin
  if coalesce(new.is_group,false) is not true then return new; end if;

  v_text := trim(coalesce(new.text_body,'') || ' ' || coalesce(new.caption,''));
  v_norm := lower(unaccent(v_text));
  v_url := agency_ops.extract_google_meet_url(v_text);
  if v_url is null then return new; end if;

  select oc.id,oc.current_stage,s.status,s.due_at,c.gt_owner
    into v_case_id,v_current_stage,v_stage_status,v_due_at,v_gt_owner
  from agency_ops.whatsapp_chat_registry reg
  join agency_ops.clients c on c.id=reg.client_id
  join agency_ops.onboarding_cases oc on oc.client_id=c.id and oc.status='OPEN'
  join agency_ops.onboarding_stages s on s.case_id=oc.id and s.stage_code='INTEGRATION_MEETING'
  where reg.chat_id=new.chat_id
  order by oc.updated_at desc,oc.id desc
  limit 1;

  if v_case_id is null or nullif(btrim(coalesce(v_gt_owner,'')),'') is null then return new; end if;
  if not (v_current_stage='INTEGRATION_MEETING' or v_stage_status in ('SCHEDULED','IN_PROGRESS','PENDING')) then return new; end if;

  v_occurred_at := coalesce(new.event_at,new.received_at,now());
  v_explicit_dt := agency_ops.extract_ptbr_meeting_datetime(v_text,v_occurred_at);
  v_context_ok :=
       v_norm ~ '(integracao|reuniao de integracao|reuniao com gt)'
    or exists(
      select 1
      from agency_ops.onboarding_meeting_schedule_proposals p
      where p.case_id=v_case_id
        and p.stage_code='INTEGRATION_MEETING'
        and p.status='CONFIRMED'
        and p.confirmed_at between v_occurred_at-interval '4 hours' and v_occurred_at+interval '30 minutes'
    )
    or v_stage_status='IN_PROGRESS';

  if not v_context_ok then
    insert into agency_ops.onboarding_stage_meet_links(
      case_id,stage_code,url,provider,source,source_id,occurred_at,scheduled_for,is_current,metadata
    ) values (
      v_case_id,'INTEGRATION_MEETING',v_url,'GOOGLE_MEET','whatsapp',new.id::text,
      v_occurred_at,v_explicit_dt,false,
      jsonb_build_object('message_id',new.message_id,'chat_id',new.chat_id,'sender_name',new.sender_name,'ambiguous_context',true)
    )
    on conflict (source,source_id,url) where source_id is not null do update
      set metadata=agency_ops.onboarding_stage_meet_links.metadata||excluded.metadata,
          updated_at=now();
    return new;
  end if;

  if v_explicit_dt is not null then
    update agency_ops.onboarding_stages
       set status='SCHEDULED',due_at=v_explicit_dt,blocked_type=null,completed_at=null
     where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and status<>'DONE';
    v_due_at := v_explicit_dt;

    update agency_ops.onboarding_stage_meet_links
       set is_current=false,updated_at=now()
     where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and is_current;
    v_is_current := true;
  else
    v_is_current :=
         v_stage_status='IN_PROGRESS'
      or (v_due_at is not null and abs(extract(epoch from (v_due_at-v_occurred_at)))<=36*3600)
      or exists(
        select 1
        from agency_ops.onboarding_meeting_schedule_proposals p
        where p.case_id=v_case_id
          and p.status='CONFIRMED'
          and p.proposed_for is not distinct from v_due_at
      );
  end if;

  insert into agency_ops.onboarding_stage_meet_links(
    case_id,stage_code,url,provider,source,source_id,occurred_at,scheduled_for,is_current,metadata
  ) values (
    v_case_id,'INTEGRATION_MEETING',v_url,'GOOGLE_MEET','whatsapp',new.id::text,
    v_occurred_at,coalesce(v_explicit_dt,v_due_at,v_occurred_at),v_is_current,
    jsonb_build_object(
      'message_id',new.message_id,'chat_id',new.chat_id,'sender_name',new.sender_name,
      'explicit_schedule',v_explicit_dt is not null,'context_ok',true
    )
  )
  on conflict (source,source_id,url) where source_id is not null do update
    set occurred_at=excluded.occurred_at,
        scheduled_for=excluded.scheduled_for,
        is_current=excluded.is_current,
        metadata=agency_ops.onboarding_stage_meet_links.metadata||excluded.metadata,
        updated_at=now();

  -- Meet enviado perto do horário marcado = evidência operacional de início.
  -- Não conclui a reunião; apenas muda SCHEDULED -> IN_PROGRESS.
  if v_is_current
     and v_due_at is not null
     and v_occurred_at between v_due_at-interval '30 minutes' and v_due_at+interval '75 minutes' then
    update agency_ops.onboarding_stages
       set status='IN_PROGRESS',
           started_at=v_occurred_at,
           blocked_type=null,
           notes=case
             when coalesce(notes,'') ilike '%Meet de integração enviado no horário da reunião%'
               then notes
             else concat_ws(' | ',nullif(notes,''),'Meet de integração enviado no horário da reunião; etapa iniciada automaticamente')
           end
     where case_id=v_case_id
       and stage_code='INTEGRATION_MEETING'
       and status='SCHEDULED';
    v_started := found;

    if v_started then
      insert into agency_ops.onboarding_events(case_id,event_type,source,source_id,occurred_at,metadata)
      select v_case_id,'INTEGRATION_MEETING_STARTED','whatsapp',new.id::text,v_occurred_at,
             jsonb_build_object('stage_code','INTEGRATION_MEETING','meet_url',v_url,'scheduled_for',v_due_at,'evidence','GOOGLE_MEET_LINK_NEAR_START')
      where not exists(
        select 1 from agency_ops.onboarding_events e
        where e.case_id=v_case_id
          and e.event_type='INTEGRATION_MEETING_STARTED'
          and e.source='whatsapp'
          and e.source_id=new.id::text
      );

      update agency_ops.onboarding_cases
         set next_action_due=v_due_at+interval '75 minutes',updated_at=now()
       where id=v_case_id and status='OPEN';
    end if;
  end if;

  perform agency_ops.recalculate_onboarding_case(v_case_id);
  return new;
end
$$;

create or replace function agency_ops.enqueue_notification(
  p_notification_key text,
  p_client_id uuid,
  p_case_id bigint,
  p_category text,
  p_event_type text,
  p_severity text,
  p_title text,
  p_message text,
  p_destination_key text default 'OPS_INTERNAL',
  p_metadata jsonb default '{}'::jsonb
) returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','public'
as $$
declare
  v_dest record;
  v_engine_enabled boolean;
  v_id bigint;
  v_webhook text := 'https://hook.us1.make.com/f2jyj1in6iincbjl7q33kwpuf5sgi2n9';
  v_stage_code text;
  v_stage_status text;
  v_stage_due timestamptz;
begin
  if p_category='ONBOARDING_REALTIME' then
    select coalesce((value->>'enabled')::boolean,false)
      into v_engine_enabled
    from agency_ops.automation_settings
    where key='onboarding_realtime';
    if not coalesce(v_engine_enabled,false) then return null; end if;
  end if;

  -- Para reunião, due_at é início. Não gerar atraso crítico no minuto em que ela começa.
  -- O alerta específico de conclusão só pode nascer 75 min depois do início (60 min + 15 min de tolerância).
  if p_category='ONBOARDING_REALTIME'
     and p_case_id is not null
     and p_event_type in ('MEETING_COMPLETION_UNCONFIRMED','STAGE_OVERDUE_CRITICAL') then
    v_stage_code := nullif(split_part(p_notification_key,':',3),'');

    if v_stage_code like '%MEETING%' then
      select s.status,s.due_at
        into v_stage_status,v_stage_due
      from agency_ops.onboarding_stages s
      where s.case_id=p_case_id and s.stage_code=v_stage_code
      limit 1;

      if v_stage_status in ('DONE','SKIPPED') then return null; end if;

      -- Reuniões usam alerta específico; nunca duplicar com ONBOARDING ATRASADO.
      if p_event_type='STAGE_OVERDUE_CRITICAL' then return null; end if;

      if p_event_type='MEETING_COMPLETION_UNCONFIRMED'
         and v_stage_due is not null
         and now() < v_stage_due+interval '75 minutes' then
        return null;
      end if;
    end if;
  end if;

  select * into v_dest
  from agency_ops.notification_destinations
  where destination_key=p_destination_key and enabled;
  if not found then return null; end if;

  insert into agency_ops.notification_outbox
    (notification_key,client_id,onboarding_case_id,category,event_type,severity,title,message,destination_id,metadata)
  values
    (p_notification_key,p_client_id,p_case_id,p_category,p_event_type,p_severity,p_title,p_message,v_dest.destination_id,p_metadata)
  on conflict (notification_key) do nothing
  returning id into v_id;

  if v_id is not null then
    begin
      perform net.http_post(
        url:=v_webhook,
        headers:='{"Content-Type":"application/json"}'::jsonb,
        body:=jsonb_build_object('notification_id',v_id)
      );
    exception when others then
      null;
    end;
  end if;

  return v_id;
end
$$;

-- Corrige cases que já tinham recebido o Meet no horário antes desta migration (sem IDs hardcoded).
do $$
declare
  r record;
begin
  for r in
    select distinct on (s.case_id)
           s.case_id,s.due_at,ml.occurred_at,ml.url,ml.source_id
    from agency_ops.onboarding_stages s
    join agency_ops.onboarding_stage_meet_links ml
      on ml.case_id=s.case_id
     and ml.stage_code='INTEGRATION_MEETING'
     and ml.is_current
    join agency_ops.onboarding_cases oc on oc.id=s.case_id and oc.status='OPEN'
    where s.stage_code='INTEGRATION_MEETING'
      and s.status='SCHEDULED'
      and s.due_at is not null
      and ml.occurred_at between s.due_at-interval '30 minutes' and s.due_at+interval '75 minutes'
      and now() between s.due_at-interval '30 minutes' and s.due_at+interval '75 minutes'
    order by s.case_id,ml.occurred_at desc
  loop
    update agency_ops.onboarding_stages
       set status='IN_PROGRESS',
           started_at=r.occurred_at,
           blocked_type=null,
           notes=case
             when coalesce(notes,'') ilike '%Meet de integração enviado no horário da reunião%'
               then notes
             else concat_ws(' | ',nullif(notes,''),'Meet de integração enviado no horário da reunião; etapa iniciada automaticamente')
           end
     where case_id=r.case_id and stage_code='INTEGRATION_MEETING' and status='SCHEDULED';

    if found then
      insert into agency_ops.onboarding_events(case_id,event_type,source,source_id,occurred_at,metadata)
      select r.case_id,'INTEGRATION_MEETING_STARTED','migration_repair',coalesce(r.source_id,'meet-link'),r.occurred_at,
             jsonb_build_object('stage_code','INTEGRATION_MEETING','meet_url',r.url,'scheduled_for',r.due_at,'evidence','EXISTING_CURRENT_MEET_LINK_NEAR_START')
      where not exists(
        select 1 from agency_ops.onboarding_events e
        where e.case_id=r.case_id and e.event_type='INTEGRATION_MEETING_STARTED'
          and e.occurred_at between r.due_at-interval '30 minutes' and r.due_at+interval '75 minutes'
      );

      update agency_ops.onboarding_cases
         set next_action_due=r.due_at+interval '75 minutes',updated_at=now()
       where id=r.case_id and status='OPEN';

      perform agency_ops.recalculate_onboarding_case(r.case_id);
    end if;
  end loop;
end
$$;

-- Se algum falso positivo ainda estiver na fila, cancela antes do envio.
update agency_ops.notification_outbox n
   set status='CANCELLED',
       metadata=coalesce(n.metadata,'{}'::jsonb)||jsonb_build_object(
         'cancelled_by','meeting_start_grace_fix',
         'cancelled_at',now(),
         'reason','meeting_start_is_not_completion_deadline'
       )
where n.status in ('PENDING','PROCESSING')
  and n.event_type in ('MEETING_COMPLETION_UNCONFIRMED','STAGE_OVERDUE_CRITICAL')
  and n.onboarding_case_id is not null
  and exists(
    select 1
    from agency_ops.onboarding_stages s
    where s.case_id=n.onboarding_case_id
      and s.stage_code like '%MEETING%'
      and s.due_at is not null
      and (
        n.event_type='STAGE_OVERDUE_CRITICAL'
        or now()<s.due_at+interval '75 minutes'
      )
  );