create or replace function public.ingest_zapi_direct_test_atomic(p_payload jsonb, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
declare
  v_expected text;
  v_message_id text;
  v_moment text;
  v_event_at timestamptz;
  v_id bigint;
  v_duplicate_hits integer;
begin
  select value #>> '{}' into v_expected
  from agency_ops.automation_settings
  where key = 'WA_DIRECT_TEST_TOKEN';

  if v_expected is null or p_token is null or p_token <> v_expected then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  v_message_id := nullif(btrim(coalesce(p_payload->>'messageId', p_payload->>'messageid', '')), '');
  if v_message_id is null then
    raise exception 'missing_messageId' using errcode = '22023';
  end if;

  v_moment := coalesce(p_payload->>'momment', p_payload->>'moment');
  if v_moment ~ '^[0-9]+([.][0-9]+)?$' then
    if v_moment::numeric > 10000000000 then
      v_event_at := to_timestamp((v_moment::numeric / 1000.0)::double precision);
    else
      v_event_at := to_timestamp(v_moment::double precision);
    end if;
  end if;

  insert into agency_ops.whatsapp_zapi_direct_test(
    capture_key, message_id, instance_id, connected_phone, chat_id, chat_name,
    participant_phone, participant_lid, sender_phone, sender_lid, sender_name,
    from_me, is_group, is_newsletter, event_type, message_type, text_body, caption,
    moment_raw, event_at, status, raw_json, received_at, last_seen_at
  ) values (
    v_message_id,
    v_message_id,
    nullif(p_payload->>'instanceId',''),
    nullif(p_payload->>'connectedPhone',''),
    nullif(coalesce(p_payload->>'phone', p_payload->>'chatId'),'') ,
    nullif(p_payload->>'chatName',''),
    nullif(p_payload->>'participantPhone',''),
    nullif(p_payload->>'participantLid',''),
    nullif(coalesce(p_payload->>'participantPhone', p_payload->>'phone'),'') ,
    nullif(p_payload->>'senderLid',''),
    nullif(coalesce(p_payload->>'senderName', p_payload->>'pushName', p_payload->>'chatName'),'') ,
    lower(coalesce(p_payload->>'fromMe','false')) = 'true',
    lower(coalesce(p_payload->>'isGroup','false')) = 'true',
    lower(coalesce(p_payload->>'isNewsletter','false')) = 'true',
    coalesce(nullif(p_payload->>'type',''),'ReceivedCallback'),
    case
      when p_payload ? 'text' then 'text'
      when p_payload ? 'image' then 'image'
      when p_payload ? 'audio' then 'audio'
      when p_payload ? 'video' then 'video'
      when p_payload ? 'document' then 'document'
      when p_payload ? 'sticker' then 'sticker'
      when p_payload ? 'contact' then 'contact'
      when p_payload ? 'location' then 'location'
      else 'other'
    end,
    nullif(p_payload#>>'{text,message}',''),
    nullif(coalesce(p_payload#>>'{image,caption}', p_payload#>>'{video,caption}', p_payload#>>'{document,caption}'),'') ,
    v_moment,
    v_event_at,
    nullif(p_payload->>'status',''),
    p_payload,
    now(),
    now()
  )
  on conflict (capture_key) do update set
    duplicate_hits = agency_ops.whatsapp_zapi_direct_test.duplicate_hits + 1,
    last_seen_at = now(),
    instance_id = coalesce(agency_ops.whatsapp_zapi_direct_test.instance_id, excluded.instance_id),
    connected_phone = coalesce(agency_ops.whatsapp_zapi_direct_test.connected_phone, excluded.connected_phone),
    chat_id = coalesce(agency_ops.whatsapp_zapi_direct_test.chat_id, excluded.chat_id),
    chat_name = coalesce(agency_ops.whatsapp_zapi_direct_test.chat_name, excluded.chat_name),
    participant_phone = coalesce(agency_ops.whatsapp_zapi_direct_test.participant_phone, excluded.participant_phone),
    participant_lid = coalesce(agency_ops.whatsapp_zapi_direct_test.participant_lid, excluded.participant_lid),
    sender_phone = coalesce(agency_ops.whatsapp_zapi_direct_test.sender_phone, excluded.sender_phone),
    sender_lid = coalesce(agency_ops.whatsapp_zapi_direct_test.sender_lid, excluded.sender_lid),
    sender_name = coalesce(agency_ops.whatsapp_zapi_direct_test.sender_name, excluded.sender_name),
    text_body = coalesce(agency_ops.whatsapp_zapi_direct_test.text_body, excluded.text_body),
    caption = coalesce(agency_ops.whatsapp_zapi_direct_test.caption, excluded.caption),
    event_at = coalesce(agency_ops.whatsapp_zapi_direct_test.event_at, excluded.event_at),
    raw_json = excluded.raw_json
  returning id, duplicate_hits into v_id, v_duplicate_hits;

  return jsonb_build_object('ok', true, 'accepted', true, 'id', v_id, 'duplicateHits', v_duplicate_hits);
end;
$$;

revoke all on function public.ingest_zapi_direct_test_atomic(jsonb,text) from public;
grant execute on function public.ingest_zapi_direct_test_atomic(jsonb,text) to anon, service_role;
