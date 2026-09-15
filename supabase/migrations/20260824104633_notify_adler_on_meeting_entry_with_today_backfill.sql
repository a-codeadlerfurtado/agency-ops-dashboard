create or replace function agency_ops.notify_adler_on_meeting_entry()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public'
as $function$
declare
  v_client_name text;
  v_topic_label text;
  v_description text;
  v_title text;
begin
  -- Evita avisar o Adler sobre a própria entrada em reunião.
  if new.person = 'Adler Furtado' then
    return new;
  end if;

  if new.client_id is not null then
    select c.display_name into v_client_name
    from agency_ops.clients c
    where c.id = new.client_id;
  end if;

  v_topic_label := case
    when nullif(btrim(coalesce(new.topic,'')),'') is null then null
    else initcap(replace(new.topic,'_',' '))
  end;

  v_title := '🟢 ' || new.person || ' entrou em reunião';
  v_description :=
      'Colaborador: ' || new.person || E'\n'
    || 'Cliente: ' || coalesce(v_client_name,'identificando...') || E'\n'
    || 'Assunto: ' || coalesce(v_topic_label,'identificando...') || E'\n'
    || 'Início: ' || to_char(new.started_at at time zone 'America/Sao_Paulo','DD/MM HH24:MI')
    || case when nullif(btrim(coalesce(new.summary,'')),'') is not null
            then E'\n\nResumo: ' || left(new.summary,900)
            else '' end;

  insert into agency_ops.platform_notifications(
    event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,metadata
  ) values (
    'meeting-entry:adler:' || new.id::text,
    'COLLABORATOR_MEETING_STARTED',
    'INFO',
    v_title,
    v_description,
    new.client_id,
    null,
    'meeting_radar',
    new.person,
    new.started_at,
    jsonb_strip_nulls(jsonb_build_object(
      'private_to_person', true,
      'target_person', 'Adler Furtado',
      'meeting_presence_event_id', new.id,
      'meeting_status', new.status,
      'meeting_source', new.source,
      'meeting_code', new.meeting_code,
      'meet_url', new.meet_url,
      'topic', new.topic,
      'confidence', new.confidence,
      'transcript_id', new.transcript_id,
      'context_available', (new.client_id is not null or new.topic is not null or new.summary is not null)
    ))
  )
  on conflict (event_key) do update
  set title = excluded.title,
      description = excluded.description,
      client_id = excluded.client_id,
      source = excluded.source,
      actor = excluded.actor,
      occurred_at = excluded.occurred_at,
      metadata = excluded.metadata;

  return new;
end;
$function$;

drop trigger if exists trg_notify_adler_meeting_entry on agency_ops.meeting_presence_events;
create trigger trg_notify_adler_meeting_entry
after insert or update on agency_ops.meeting_presence_events
for each row execute function agency_ops.notify_adler_on_meeting_entry();

-- Retroativo de hoje: cria o radar para reuniões reais do Donnah cujo feed é de hoje.
insert into agency_ops.meeting_presence_events(
  person, client_id, status, started_at, ended_at, meet_url, meeting_code,
  source, source_record_id, confidence, topic, summary, transcript_id, evidence
)
select
  t.metadata->>'mcp_owner_person' as person,
  t.client_id,
  case when t.client_id is not null or t.metadata->>'tipo_reuniao' is not null or t.metadata->>'donnah_summary' is not null
       then 'CONTEXT_AVAILABLE' else 'DETECTED' end,
  t.meeting_started_at,
  null,
  case when t.meeting_code is not null then 'https://meet.google.com/' || t.meeting_code else null end,
  t.meeting_code,
  'DONNAH_TRANSCRIPT',
  t.id::text,
  t.match_confidence,
  t.metadata->>'tipo_reuniao',
  coalesce(nullif(t.metadata->>'donnah_summary',''), t.summary),
  t.id,
  jsonb_strip_nulls(jsonb_build_object(
    'retroactive_today', true,
    'evidence_type','DONNAH_TRANSCRIPT_AVAILABLE',
    'donnah_feed_id',t.metadata->>'mcp_feed_id',
    'donnah_document_id',t.metadata->>'mcp_document_id',
    'donnah_title',t.metadata->>'donnah_title',
    'participants',t.participants,
    'match_status',t.match_status
  ))
from agency_ops.meeting_transcripts t
where t.meeting_started_at is not null
  and nullif(t.metadata->>'mcp_owner_person','') is not null
  and t.metadata->>'mcp_owner_person' <> 'Adler Furtado'
  and nullif(t.metadata->>'donnah_feed_date','') is not null
  and (((t.metadata->>'donnah_feed_date')::timestamptz at time zone 'America/Sao_Paulo')::date = current_date)
  and not exists (
    select 1
    from agency_ops.meeting_presence_events m
    where m.transcript_id = t.id
       or (
         t.meeting_code is not null
         and m.meeting_code = t.meeting_code
         and m.person = t.metadata->>'mcp_owner_person'
         and abs(extract(epoch from (m.started_at - t.meeting_started_at))) <= 7200
       )
  );

-- Faz o registro já existente de hoje também gerar/atualizar a notificação privada.
update agency_ops.meeting_presence_events
set evidence = evidence || jsonb_build_object('adler_profile_notification_backfill', true),
    updated_at = now()
where person <> 'Adler Furtado'
  and (started_at at time zone 'America/Sao_Paulo')::date = current_date;
