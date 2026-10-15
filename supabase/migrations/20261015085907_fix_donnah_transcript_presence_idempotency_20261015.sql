-- Recorded production migration 20261015085907.
-- Fix: reprocessing an existing DONNAH_TRANSCRIPT presence event must not violate
-- meeting_presence_events_source_source_record_id_key.
-- Controlled transaction rollback smoke-test passed for transcript 1581 on 2026-10-15.
-- Preserve existing event ID and avoid duplicate start notifications.
CREATE OR REPLACE FUNCTION agency_ops.enrich_meeting_presence_from_transcript()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'agency_ops', 'public', 'extensions'
AS $function$
declare
  v_person text;
  v_started timestamptz;
  v_topic text;
  v_summary text;
  v_event agency_ops.meeting_presence_events%rowtype;
  v_event_id bigint;
  v_client uuid;
  v_client_name text;
  v_notification bigint;
  v_is_new boolean := false;
begin
  if new.processed_at is null then return new; end if;
  if tg_op='UPDATE' and old.processed_at is not null
     and old.client_id is not distinct from new.client_id
     and coalesce(old.metadata->>'tipo_reuniao','')=coalesce(new.metadata->>'tipo_reuniao','')
     and coalesce(old.summary,'')=coalesce(new.summary,'') then
    return new;
  end if;

  v_person := nullif(new.metadata->>'mcp_owner_person','');
  if v_person is null then return new; end if;

  v_started := coalesce(new.meeting_started_at,new.source_created_at,new.ingested_at,new.created_at,now());
  v_topic := nullif(new.metadata->>'tipo_reuniao','');
  v_summary := coalesce(nullif(new.metadata->>'donnah_summary',''),nullif(new.summary,''));

  -- Source identity takes precedence over approximate temporal matching.
  select e.* into v_event
  from agency_ops.meeting_presence_events e
  where e.source='DONNAH_TRANSCRIPT'
    and e.source_record_id=new.id::text
  limit 1;

  if v_event.id is null then
  select e.* into v_event
  from agency_ops.meeting_presence_events e
  where e.person=v_person
    and e.status<>'CANCELLED'
    and e.started_at between v_started-interval '90 minutes' and v_started+interval '3 hours'
  order by
    case when new.meeting_code is not null and e.meeting_code=new.meeting_code then 0
         when new.client_id is not null and e.client_id=new.client_id then 1
         else 2 end,
    abs(extract(epoch from (e.started_at-v_started))) asc
  limit 1;
  end if;

  if v_event.id is null then
    insert into agency_ops.meeting_presence_events(
      person,client_id,status,started_at,meeting_code,source,source_record_id,
      confidence,topic,summary,transcript_id,evidence
    ) values (
      v_person,new.client_id,'CONTEXT_AVAILABLE',v_started,new.meeting_code,'DONNAH_TRANSCRIPT',new.id::text,
      case when new.client_id is not null then 0.88 else 0.72 end,
      v_topic,v_summary,new.id,
      jsonb_build_object(
        'donnah_feed_id',new.metadata->>'mcp_feed_id',
        'donnah_document_id',new.metadata->>'mcp_document_id',
        'participants',coalesce(new.participants,'[]'::jsonb),
        'match_status',new.match_status,
        'evidence_type','DONNAH_TRANSCRIPT_AVAILABLE'
      )
    ) on conflict (source,source_record_id) do nothing
      returning id into v_event_id;
    v_is_new := v_event_id is not null;
    if v_event_id is null then
      select e.id into v_event_id
      from agency_ops.meeting_presence_events e
      where e.source='DONNAH_TRANSCRIPT'
        and e.source_record_id=new.id::text;
      if v_event_id is null then
        raise exception 'Meeting presence conflict could not resolve transcript %',new.id;
      end if;
    end if;
  else
    v_event_id := v_event.id;
    update agency_ops.meeting_presence_events
       set client_id=coalesce(client_id,new.client_id),
           status=case when status='IN_PROGRESS' then 'CONTEXT_AVAILABLE' else status end,
           meeting_code=coalesce(meeting_code,new.meeting_code),
           topic=coalesce(v_topic,topic),
           summary=coalesce(v_summary,summary),
           transcript_id=new.id,
           confidence=greatest(coalesce(confidence,0),case when coalesce(client_id,new.client_id) is not null then 0.92 else 0.78 end),
           evidence=coalesce(evidence,'{}'::jsonb)||jsonb_build_object(
             'donnah_feed_id',new.metadata->>'mcp_feed_id',
             'donnah_document_id',new.metadata->>'mcp_document_id',
             'participants',coalesce(new.participants,'[]'::jsonb),
             'transcript_match_status',new.match_status,
             'transcript_client_id',new.client_id,
             'donnah_context_at',now()
           ),
           updated_at=now()
     where id=v_event_id;
  end if;

  select e.client_id,e.context_notified_at into v_client,v_event.context_notified_at
  from agency_ops.meeting_presence_events e where e.id=v_event_id;
  if v_client is not null then
    select c.display_name into v_client_name from agency_ops.clients c where c.id=v_client;
  end if;

  -- Se o Donnah foi a primeira fonte, avisa que uma reunião foi detectada.
  if v_is_new then
    v_notification := agency_ops.enqueue_notification(
      'meeting-radar:start-donnah:'||v_event_id::text,
      v_client,
      null,
      'MEETING_RADAR',
      'MEETING_DETECTED_DONNAH',
      'INFO',
      '🟣 REUNIÃO DETECTADA PELO DONNAH',
      'Colaborador: '||v_person||E'\n'
        ||'Cliente: '||coalesce(v_client_name,'Ainda não identificado')||E'\n'
        ||'Assunto: '||coalesce(v_topic,'Ainda não identificado')||E'\n'
        ||'Início estimado: '||to_char(v_started at time zone 'America/Sao_Paulo','DD/MM HH24:MI')||E'\n'
        ||'Observação: detectada quando o Donnah disponibilizou a transcrição.',
      'OPS_INTERNAL',
      jsonb_build_object('meeting_presence_event_id',v_event_id,'person',v_person,'transcript_id',new.id,'source','DONNAH_TRANSCRIPT')
    );
    if v_notification is not null then
      update agency_ops.meeting_presence_events set start_notified_at=coalesce(start_notified_at,now()),updated_at=now() where id=v_event_id;
    end if;
  end if;

  -- Enriquecimento separado: cliente/assunto/resumo identificados a partir da transcrição.
  if v_event.context_notified_at is null
     and (v_client is not null or v_topic is not null or v_summary is not null) then
    v_notification := agency_ops.enqueue_notification(
      'meeting-radar:context:'||v_event_id::text,
      v_client,
      null,
      'MEETING_RADAR',
      'MEETING_CONTEXT_IDENTIFIED',
      'INFO',
      '🧠 CONTEXTO DA REUNIÃO',
      'Colaborador: '||v_person||E'\n'
        ||'Cliente: '||coalesce(v_client_name,'Não identificado')||E'\n'
        ||'Assunto: '||coalesce(v_topic,'Não classificado')||E'\n'
        ||case when v_summary is not null then 'Resumo: '||left(regexp_replace(v_summary,E'[\r\n]+',' ','g'),500) else 'Resumo: aguardando dados suficientes' end,
      'OPS_INTERNAL',
      jsonb_build_object(
        'meeting_presence_event_id',v_event_id,
        'person',v_person,
        'client_id',v_client,
        'topic',v_topic,
        'transcript_id',new.id,
        'source','DONNAH_TRANSCRIPT'
      )
    );
    if v_notification is not null then
      update agency_ops.meeting_presence_events set context_notified_at=now(),updated_at=now() where id=v_event_id;
    end if;
  end if;

  return new;
end
$function$
;
