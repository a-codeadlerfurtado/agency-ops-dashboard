-- Already applied to imobi-pro. Suppresses expensive processing for the churned client while preserving data.
CREATE OR REPLACE FUNCTION imobi_board_priv.reconcile_renata_fiel_whatsapp_identities()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'imobi_board', 'imobi_board_priv'
AS $function$
declare
  v_refresh jsonb;
  rec record;
  v_reprocessed integer := 0;
begin
  if exists (
    select 1 from imobi_board.tenants t
    join agency_ops.clients c on c.id=t.agency_client_id
    where t.id='200ddf3f-0fee-49cc-a643-f73f2f93dcbc'::uuid
      and (c.lifecycle='CHURNED' or t.status::text='INACTIVE')
  ) then
    return jsonb_build_object('ok',true,'skipped','client_churned_or_tenant_inactive','reprocessed',0);
  end if;

  v_refresh := imobi_board_priv.refresh_renata_fiel_whatsapp_identities(null,50);

  for rec in
    select source_message_row_id
    from imobi_board.renata_fiel_whatsapp_messages
    where tenant_id='200ddf3f-0fee-49cc-a643-f73f2f93dcbc'::uuid
      and match_status <> 'MATCHED'
      and source_message_row_id is not null
      and event_at >= now() - interval '30 days'
    order by event_at desc
    limit 200
  loop
    perform imobi_board_priv.sync_renata_fiel_whatsapp_message(rec.source_message_row_id);
    v_reprocessed := v_reprocessed + 1;
  end loop;

  return jsonb_build_object(
    'refresh',v_refresh,
    'reprocessed',v_reprocessed
  );
end
$function$
;
CREATE OR REPLACE FUNCTION imobi_board_priv.refresh_renata_fiel_whatsapp_identities(p_contact_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'agency_ops', 'imobi_board', 'imobi_board_priv', 'extensions'
AS $function$
declare
  cfg imobi_board.renata_fiel_whatsapp_config%rowtype;
  rec record;
  v_instance_token text;
  v_client_token text;
  v_resp extensions.http_response;
  v_body jsonb;
  v_lid text;
  v_exists boolean;
  v_ok integer := 0;
  v_failed integer := 0;
begin
  select * into cfg
  from imobi_board.renata_fiel_whatsapp_config
  where active = true
    and instance_id = '3F95B37A38AAB17B4C56B2194C7A232A'
  order by updated_at desc
  limit 1;

  if not found or cfg.tenant_id is null then
    return jsonb_build_object('ok',false,'reason','config_not_found');
  end if;

  if exists (
    select 1 from imobi_board.tenants t
    join agency_ops.clients c on c.id=t.agency_client_id
    where t.id=cfg.tenant_id and (c.lifecycle='CHURNED' or t.status::text='INACTIVE')
  ) then
    return jsonb_build_object('ok',true,'skipped','client_churned_or_tenant_inactive','refreshed',0,'failed',0);
  end if;

  v_instance_token := agency_ops.get_secret('zapi_renata_fiel_instance_token');
  v_client_token := agency_ops.get_secret('zapi_client_token');

  if coalesce(v_instance_token,'') = '' or coalesce(v_client_token,'') = '' then
    return jsonb_build_object('ok',false,'reason','missing_secret');
  end if;

  for rec in
    select
      c.id as contact_id,
      imobi_board_priv.normalize_whatsapp_phone(coalesce(c.phone_normalized,c.phone)) as phone
    from imobi_board.contacts c
    left join imobi_board_priv.renata_fiel_whatsapp_identity_map m
      on m.tenant_id = c.tenant_id and m.contact_id = c.id
    where c.tenant_id = cfg.tenant_id
      and (p_contact_id is null or c.id = p_contact_id)
      and imobi_board_priv.normalize_whatsapp_phone(coalesce(c.phone_normalized,c.phone)) ~ '^[0-9]{10,15}$'
      and (
        p_contact_id is not null
        or m.contact_id is null
        or m.lid is null
        or m.phone_normalized is distinct from imobi_board_priv.normalize_whatsapp_phone(coalesce(c.phone_normalized,c.phone))
        or m.last_checked_at < now() - interval '7 days'
      )
    order by c.created_at desc
    limit greatest(1,least(coalesce(p_limit,50),100))
  loop
    begin
      v_resp := extensions.http((
        'GET'::extensions.http_method,
        ('https://api.z-api.io/instances/' || cfg.instance_id ||
          '/token/' || v_instance_token ||
          '/phone-exists/' || rec.phone)::varchar,
        array[extensions.http_header('Client-Token',v_client_token)]::extensions.http_header[],
        null::varchar,
        null::varchar
      )::extensions.http_request);

      v_body := case
        when coalesce(v_resp.content,'') = '' then '{}'::jsonb
        else v_resp.content::jsonb
      end;

      if jsonb_typeof(v_body) = 'array' then
        v_lid := nullif(lower(v_body->0->>'lid'),'');
        v_exists := coalesce((v_body->0->>'exists')::boolean,false);
      else
        v_lid := nullif(lower(v_body->>'lid'),'');
        v_exists := coalesce((v_body->>'exists')::boolean,false);
      end if;

      insert into imobi_board_priv.renata_fiel_whatsapp_identity_map(
        tenant_id,contact_id,phone_normalized,lid,last_status,last_error,last_checked_at,updated_at
      )
      values(
        cfg.tenant_id,rec.contact_id,rec.phone,
        case when v_exists then v_lid else null end,
        v_resp.status,
        case when v_resp.status between 200 and 299 then null else left(v_resp.content,500) end,
        now(),now()
      )
      on conflict (tenant_id,contact_id) do update set
        phone_normalized=excluded.phone_normalized,
        lid=excluded.lid,
        last_status=excluded.last_status,
        last_error=excluded.last_error,
        last_checked_at=excluded.last_checked_at,
        updated_at=now();

      if v_resp.status between 200 and 299 then
        v_ok := v_ok + 1;
      else
        v_failed := v_failed + 1;
      end if;
    exception when others then
      insert into imobi_board_priv.renata_fiel_whatsapp_identity_map(
        tenant_id,contact_id,phone_normalized,last_status,last_error,last_checked_at,updated_at
      )
      values(cfg.tenant_id,rec.contact_id,rec.phone,null,left(sqlerrm,500),now(),now())
      on conflict (tenant_id,contact_id) do update set
        phone_normalized=excluded.phone_normalized,
        last_status=null,
        last_error=excluded.last_error,
        last_checked_at=excluded.last_checked_at,
        updated_at=now();
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object('ok',true,'refreshed',v_ok,'failed',v_failed);
end
$function$
;
