begin;
create table agency_ops.whatsapp_media_context (
  message_row_id bigint primary key references agency_ops.whatsapp_messages(id) on delete cascade,
  client_id uuid not null,
  chat_id text not null,
  media_type text not null check(media_type in ('audio','image','video')),
  source_url text,
  mime_type text,
  duration_seconds numeric,
  status text not null default 'PENDING' check(status in ('PENDING','PROCESSING','DONE','PARTIAL','RETRY','UNAVAILABLE','REVIEW')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  storage_path text,
  bytes bigint,
  transcript text,
  description text,
  summary text,
  extracted_text text,
  interpretation jsonb,
  coverage text,
  model text,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table agency_ops.whatsapp_media_context enable row level security;
revoke all on agency_ops.whatsapp_media_context from public,anon,authenticated;
grant all on agency_ops.whatsapp_media_context to service_role;
create index whatsapp_media_due on agency_ops.whatsapp_media_context(next_attempt_at,message_row_id) where status in ('PENDING','RETRY');
create index whatsapp_media_client on agency_ops.whatsapp_media_context(client_id,created_at desc);
create index whatsapp_media_search on agency_ops.whatsapp_media_context using gin(to_tsvector('portuguese',coalesce(transcript,'')||' '||coalesce(extracted_text,'')||' '||coalesce(description,'')||' '||coalesce(summary,'')));
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('whatsapp-client-media','whatsapp-client-media',false,26214400,array['audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/webm','video/mp4','video/webm','image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;

create function agency_ops.wake_whatsapp_media_worker() returns bigint language plpgsql security definer set search_path=pg_catalog,agency_ops as $$
declare secret text; request_id bigint;
begin
  select value#>>'{}' into secret from agency_ops.automation_settings where key='SEMANTIC_QUEUE_WORKER_SECRET';
  if length(coalesce(secret,''))<32 then return null; end if;
  select net.http_post(url:='https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-whatsapp-media-worker',headers:=jsonb_build_object('Content-Type','application/json','x-semantic-worker-key',secret),body:='{}'::jsonb,timeout_milliseconds:=1000) into request_id;
  return request_id;
end $$;
revoke all on function agency_ops.wake_whatsapp_media_worker() from public,anon,authenticated;
grant execute on function agency_ops.wake_whatsapp_media_worker() to service_role;

create function agency_ops.enqueue_whatsapp_media_context() returns trigger language plpgsql security definer set search_path=pg_catalog,agency_ops as $$
declare cid uuid; m jsonb; u text; n integer;
begin
 if not coalesce(new.is_group,false) or new.message_type not in ('audio','image','video') then return new; end if;
 select client_id into cid from agency_ops.whatsapp_group_registry where chat_id=new.chat_id and group_kind='CLIENTE' limit 1;
 if cid is null then return new; end if;
 m:=new.raw_json->new.message_type;
 u:=coalesce(m->>'audioUrl',m->>'imageUrl',m->>'videoUrl');
 insert into agency_ops.whatsapp_media_context(message_row_id,client_id,chat_id,media_type,source_url,mime_type,duration_seconds,status,last_error)
 values(new.id,cid,new.chat_id,new.message_type,u,split_part(m->>'mimeType',';',1),case when m->>'seconds' ~ '^\d+(\.\d+)?$' then (m->>'seconds')::numeric end,
 case when u is null then 'UNAVAILABLE' else 'PENDING' end,case when u is null then 'source_url_missing' end)
 on conflict(message_row_id) do update set source_url=excluded.source_url,status='PENDING',next_attempt_at=now(),last_error=null,updated_at=now()
 where whatsapp_media_context.status='UNAVAILABLE' and excluded.source_url is not null;
 get diagnostics n=row_count;
 if n>0 and u is not null then perform agency_ops.wake_whatsapp_media_worker(); end if;
 return new;
exception when others then
 -- Media enrichment must never interrupt the established WhatsApp ingress.
 raise warning 'whatsapp_media_enqueue_failed message % sqlstate %',new.id,sqlstate;
 return new;
end $$;
revoke all on function agency_ops.enqueue_whatsapp_media_context() from public,anon,authenticated;
create trigger trg_enqueue_whatsapp_media_context after insert or update of raw_json,message_type on agency_ops.whatsapp_messages for each row execute function agency_ops.enqueue_whatsapp_media_context();

create function agency_ops.claim_whatsapp_media_context() returns setof agency_ops.whatsapp_media_context language plpgsql security invoker set search_path=pg_catalog,agency_ops as $$
begin
 update agency_ops.whatsapp_media_context set status='RETRY',locked_at=null,next_attempt_at=now(),last_error='processing_lease_expired' where status='PROCESSING' and locked_at<now()-interval '5 minutes';
 return query update agency_ops.whatsapp_media_context m set status='PROCESSING',attempts=m.attempts+1,locked_at=now(),updated_at=now()
 where m.message_row_id=(select q.message_row_id from agency_ops.whatsapp_media_context q where q.status in ('PENDING','RETRY') and q.next_attempt_at<=now() and q.attempts<5 order by case q.media_type when 'audio' then 0 when 'image' then 1 else 2 end,q.message_row_id desc for update skip locked limit 1) returning m.*;
end $$;
revoke all on function agency_ops.claim_whatsapp_media_context() from public,anon,authenticated;
grant execute on function agency_ops.claim_whatsapp_media_context() to service_role;

create view agency_ops.whatsapp_messages_with_context with(security_invoker=true) as
 select w.*,m.status as media_processing_status,m.transcript as media_transcript,m.description as media_description,m.summary as media_summary,m.extracted_text as media_extracted_text,m.coverage as media_coverage,m.interpretation as media_interpretation,
 concat_ws(E'\n',nullif(w.text_body,''),nullif(w.caption,''),case when nullif(m.transcript,'') is not null then '[TRANSCRICAO DE '||upper(m.media_type)||'] '||m.transcript end,case when nullif(m.extracted_text,'') is not null then '[TEXTO EXTRAIDO] '||m.extracted_text end,case when nullif(m.description,'') is not null then '[DESCRICAO IA] '||m.description end,case when nullif(m.summary,'') is not null then '[RESUMO IA] '||m.summary end) as context_body
 from agency_ops.whatsapp_messages w left join agency_ops.whatsapp_media_context m on m.message_row_id=w.id;
revoke all on agency_ops.whatsapp_messages_with_context from public,anon,authenticated;
grant select on agency_ops.whatsapp_messages_with_context to service_role;

create function agency_ops.whatsapp_media_watchdog() returns bigint language plpgsql security definer set search_path=pg_catalog,agency_ops as $$
begin
 if exists(select 1 from agency_ops.whatsapp_media_context where (status in ('PENDING','RETRY') and next_attempt_at<=now() and attempts<5) or (status='PROCESSING' and locked_at<now()-interval '5 minutes')) then return agency_ops.wake_whatsapp_media_worker(); end if;
 return null;
end $$;
revoke all on function agency_ops.whatsapp_media_watchdog() from public,anon,authenticated;
grant execute on function agency_ops.whatsapp_media_watchdog() to service_role;
select cron.schedule('whatsapp-media-recovery','*/2 * * * *','select agency_ops.whatsapp_media_watchdog()');
comment on table agency_ops.whatsapp_media_context is 'Derived media content, never replaces original messages. Restricted to service role and existing authorized readers.';
commit;
