create or replace function agency_ops.claim_meeting_ready_notification(p_transcript_id bigint)
returns table(notification_id uuid, owner_person text, recipient_phone text, title text, client_name text)
language plpgsql
security definer
set search_path=agency_ops,public,extensions
as $$
declare
  v_owner text;
  v_phone text;
  v_title text;
  v_client text;
  v_id uuid;
begin
  select mt.owner_person,
         coalesce(nullif(mt.client_name_raw,''), 'Cliente não vinculado'),
         coalesce(nullif(mt.source_file_name,''), nullif(mt.meeting_code,''), 'Reunião')
    into v_owner, v_client, v_title
  from agency_ops.meeting_transcripts mt
  where mt.id=p_transcript_id
    and mt.processing_status='READY';

  if v_owner is null then return; end if;

  select tim.whatsapp_phone into v_phone
  from agency_ops.team_identity_map tim
  where tim.person=v_owner
  limit 1;

  insert into agency_ops.meeting_ready_notifications(transcript_id,owner_person,recipient_phone,status)
  values (p_transcript_id,v_owner,v_phone,case when v_phone is null or btrim(v_phone)='' then 'SKIPPED' else 'PENDING' end)
  on conflict (transcript_id,channel) do update
    set recipient_phone=coalesce(agency_ops.meeting_ready_notifications.recipient_phone,excluded.recipient_phone),
        updated_at=now();

  update agency_ops.meeting_ready_notifications n
     set status='SENDING', attempts=n.attempts+1, updated_at=now(), last_error=null
   where n.transcript_id=p_transcript_id
     and n.channel='ZAPI'
     and n.recipient_phone is not null
     and btrim(n.recipient_phone)<>''
     and (n.status in ('PENDING','FAILED') or (n.status='SENDING' and n.updated_at < now()-interval '5 minutes'))
  returning n.id into v_id;

  if v_id is null then return; end if;
  return query select v_id,v_owner,v_phone,v_title,v_client;
end;
$$;

create or replace function agency_ops.finish_meeting_ready_notification(p_notification_id uuid,p_ok boolean,p_error text default null)
returns void
language plpgsql
security definer
set search_path=agency_ops,public,extensions
as $$
begin
  update agency_ops.meeting_ready_notifications
     set status=case when p_ok then 'SENT' else 'FAILED' end,
         sent_at=case when p_ok then now() else sent_at end,
         last_error=case when p_ok then null else left(coalesce(p_error,'send_failed'),2000) end,
         next_attempt_at=case when p_ok then next_attempt_at else now()+interval '2 minutes' end,
         updated_at=now()
   where id=p_notification_id;
end;
$$;

revoke all on function agency_ops.claim_meeting_ready_notification(bigint) from public,anon,authenticated;
revoke all on function agency_ops.finish_meeting_ready_notification(uuid,boolean,text) from public,anon,authenticated;
grant execute on function agency_ops.claim_meeting_ready_notification(bigint) to service_role;
grant execute on function agency_ops.finish_meeting_ready_notification(uuid,boolean,text) to service_role;