create or replace function agency_ops.ingest_whatsapp_message(p jsonb, p_source text default 'zapi_mirror'::text)
returns table(inserted boolean)
language plpgsql
security definer
set search_path to 'agency_ops'
as $$
declare
  v_moment text := coalesce(p->>'momment', p->>'moment');
  v_existing bigint;
begin
  if p_source in ('sheets_backfill','zapi_mirror') then
    return query select false;
    return;
  end if;

  select id into v_existing from agency_ops.whatsapp_messages where message_id=p->>'messageId' limit 1;

  insert into agency_ops.whatsapp_messages(
    message_id, instance_id, chat_id, chat_name,
    connected_phone, participant_phone, participant_lid,
    sender_phone, sender_lid, sender_name,
    from_me, is_group, is_newsletter, event_type, message_type,
    text_body, caption, moment_raw, event_at, is_edit, status, source, raw_json
  ) values (
    p->>'messageId', p->>'instanceId',
    coalesce(p->>'phone', p->>'chatId'), p->>'chatName',
    p->>'connectedPhone', p->>'participantPhone', p->>'participantLid',
    coalesce(p->>'participantPhone', p->>'phone'), coalesce(p->>'participantLid', p->>'senderLid'),
    coalesce(p->>'senderName', p->>'pushName', p->>'chatName'),
    coalesce((p->>'fromMe')::boolean,false), coalesce((p->>'isGroup')::boolean,false), coalesce((p->>'isNewsletter')::boolean,false),
    coalesce(p->>'type','ReceivedCallback'),
    case when p ? 'image' then 'image' when p ? 'audio' then 'audio'
         when p ? 'video' then 'video' when p ? 'document' then 'document'
         when p ? 'text' then 'text' else 'other' end,
    p#>>'{text,message}',
    coalesce(p#>>'{image,caption}', p#>>'{video,caption}'),
    v_moment, agency_ops.epoch_to_ts(v_moment),
    coalesce((p->>'isEdit')::boolean,false), p->>'status', p_source, p
  )
  on conflict (message_id) do update set
    instance_id=coalesce(excluded.instance_id,agency_ops.whatsapp_messages.instance_id),
    chat_id=coalesce(excluded.chat_id,agency_ops.whatsapp_messages.chat_id),
    chat_name=coalesce(excluded.chat_name,agency_ops.whatsapp_messages.chat_name),
    connected_phone=coalesce(excluded.connected_phone,agency_ops.whatsapp_messages.connected_phone),
    participant_phone=coalesce(excluded.participant_phone,agency_ops.whatsapp_messages.participant_phone),
    participant_lid=coalesce(excluded.participant_lid,agency_ops.whatsapp_messages.participant_lid),
    sender_phone=coalesce(excluded.sender_phone,agency_ops.whatsapp_messages.sender_phone),
    sender_lid=coalesce(excluded.sender_lid,agency_ops.whatsapp_messages.sender_lid),
    sender_name=coalesce(excluded.sender_name,agency_ops.whatsapp_messages.sender_name),
    from_me=excluded.from_me,
    is_group=excluded.is_group,
    is_newsletter=excluded.is_newsletter,
    event_type=coalesce(excluded.event_type,agency_ops.whatsapp_messages.event_type),
    message_type=coalesce(excluded.message_type,agency_ops.whatsapp_messages.message_type),
    text_body=case
      when nullif(btrim(coalesce(excluded.text_body,'')),'') is not null then excluded.text_body
      else agency_ops.whatsapp_messages.text_body end,
    caption=coalesce(excluded.caption,agency_ops.whatsapp_messages.caption),
    moment_raw=coalesce(excluded.moment_raw,agency_ops.whatsapp_messages.moment_raw),
    event_at=coalesce(excluded.event_at,agency_ops.whatsapp_messages.event_at),
    is_edit=agency_ops.whatsapp_messages.is_edit or excluded.is_edit,
    status=coalesce(excluded.status,agency_ops.whatsapp_messages.status),
    source=excluded.source,
    raw_json=coalesce(agency_ops.whatsapp_messages.raw_json,'{}'::jsonb) || coalesce(excluded.raw_json,'{}'::jsonb),
    received_at=greatest(agency_ops.whatsapp_messages.received_at,excluded.received_at);

  return query select v_existing is null;
end
$$;
