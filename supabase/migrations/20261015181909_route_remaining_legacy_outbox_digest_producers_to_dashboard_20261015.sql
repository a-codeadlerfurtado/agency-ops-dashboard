-- Versioned copy of migration already applied to imobi-pro on 2026-10-15.
-- Routes active digests to dashboard-only private notifications, no WhatsApp replay.
CREATE OR REPLACE FUNCTION agency_ops.notify_client_waiting_whatsapp()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'agency_ops', 'public'
AS $function$
declare
 v_key text := 'client_waiting:' || to_char(now() at time zone 'America/Sao_Paulo','YYYYMMDD_HH24');
 v_digest jsonb;
 v_n integer;
begin
 if exists(select 1 from agency_ops.platform_notifications where event_key=v_key) then return 0; end if;
 v_digest:=agency_ops.build_client_waiting_digest();
 if coalesce((v_digest->>'vazio')::boolean,false) then return 0; end if;
 insert into agency_ops.platform_notifications(event_key,type,level,title,description,source,actor,occurred_at,metadata)
 values(v_key,'CLIENT_WAITING_DIGEST',
        case when upper(coalesce(v_digest->>'severity','INFO'))='CRITICAL' then 'CRITICAL'
             when upper(coalesce(v_digest->>'severity','INFO')) in ('WARNING','ATTENTION') then 'ATTENTION'
             else 'INFO' end,
        'Clientes aguardando resposta',left(coalesce(v_digest->>'message',''),12000),
        'client_waiting_digest','Sistema',now(),
        (coalesce(v_digest,'{}'::jsonb)-'message')||
        jsonb_build_object('private_to_person',true,'target_person','Adler Furtado',
                           'target_role','MGMT','legacy_outbox_replacement',true))
 on conflict(event_key) do nothing;
 get diagnostics v_n=row_count;
 return v_n;
end;$function$
;
revoke all on function agency_ops.notify_client_waiting_whatsapp() from public,anon,authenticated;

CREATE OR REPLACE FUNCTION agency_ops.notify_meta_balance_whatsapp_digest()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'agency_ops', 'public'
AS $function$
declare
 v_key text := 'meta_balance_digest:' || to_char(now() at time zone 'America/Sao_Paulo','YYYYMMDD');
 v_digest jsonb;
 v_n integer;
begin
 if exists(select 1 from agency_ops.platform_notifications where event_key=v_key) then return 0; end if;
 v_digest:=agency_ops.build_meta_balance_digest();
 if coalesce((v_digest->>'vazio')::boolean,false) then return 0; end if;
 insert into agency_ops.platform_notifications(event_key,type,level,title,description,source,actor,occurred_at,metadata)
 values(v_key,'META_BALANCE_DAILY_DIGEST',
        case when upper(coalesce(v_digest->>'severity','INFO'))='CRITICAL' then 'CRITICAL'
             when upper(coalesce(v_digest->>'severity','INFO')) in ('WARNING','ATTENTION') then 'ATTENTION'
             else 'INFO' end,
        'Resumo diário de saldo — Meta Ads',left(coalesce(v_digest->>'message',''),12000),
        'meta_balance_digest','Sistema',now(),
        (coalesce(v_digest,'{}'::jsonb)-'message')||
        jsonb_build_object('private_to_person',true,'target_person','Adler Furtado',
                           'target_role','MGMT','legacy_outbox_replacement',true))
 on conflict(event_key) do nothing;
 get diagnostics v_n=row_count;
 return v_n;
end;$function$
;
revoke all on function agency_ops.notify_meta_balance_whatsapp_digest() from public,anon,authenticated;
