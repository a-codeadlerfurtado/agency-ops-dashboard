begin;
alter table agency_ops.whatsapp_media_context alter column client_id drop not null;
create or replace function agency_ops.enqueue_whatsapp_media_context() returns trigger language plpgsql security definer set search_path=pg_catalog,agency_ops as $$
declare cid uuid; m jsonb; u text; n integer;
begin
 if not coalesce(new.is_group,false) or new.message_type not in ('audio','image','video') then return new; end if;
 select client_id into cid from agency_ops.whatsapp_group_registry where chat_id=new.chat_id and group_kind='CLIENTE' limit 1;
 if not found then return new; end if;
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

grant select on agency_ops.whatsapp_media_context,agency_ops.whatsapp_messages_with_context to agency_ops_ai_reader;
comment on column agency_ops.whatsapp_media_context.client_id is 'Null means a registered client group awaiting client binding; never infer identity.';
commit;