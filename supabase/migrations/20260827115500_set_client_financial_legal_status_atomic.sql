create or replace function agency_ops.set_client_financial_legal_status(
  p_client_id uuid,
  p_inadimplente boolean,
  p_juridico boolean,
  p_note text default null,
  p_since date default null,
  p_actor text default null
) returns jsonb
language plpgsql
security definer
set search_path = agency_ops, pg_catalog
as $$
declare
  v_status text;
  v_desired boolean;
  v_current agency_ops.client_operational_status%rowtype;
  v_now timestamptz := now();
  v_since date := coalesce(p_since, (now() at time zone 'America/Sao_Paulo')::date);
  v_note text := nullif(trim(coalesce(p_note,'')), '');
  v_actor text := coalesce(nullif(trim(coalesce(p_actor,'')),''),'Leonardo Augusto');
begin
  if not exists(select 1 from agency_ops.clients where id=p_client_id) then
    raise exception 'client_not_found';
  end if;

  foreach v_status in array array['inadimplente','juridico'] loop
    v_desired := case when v_status='inadimplente' then coalesce(p_inadimplente,false) else coalesce(p_juridico,false) end;
    v_current := null;
    select * into v_current
    from agency_ops.client_operational_status
    where client_id=p_client_id and status=v_status and active
    limit 1;

    if not v_desired then
      if v_current.id is not null then
        update agency_ops.client_operational_status
        set active=false,resolved_at=v_now,resolved_by=v_actor
        where id=v_current.id;
      end if;
      continue;
    end if;

    if v_current.id is not null
       and coalesce(v_current.note,'')=coalesce(v_note,'')
       and v_current.since is not distinct from v_since then
      continue;
    end if;

    if v_current.id is not null then
      update agency_ops.client_operational_status
      set active=false,resolved_at=v_now,resolved_by=v_actor
      where id=v_current.id;
    end if;

    insert into agency_ops.client_operational_status(client_id,status,note,active,created_at,created_by,since)
    values(p_client_id,v_status,v_note,true,v_now,v_actor,v_since);
  end loop;

  return jsonb_build_object('ok',true,'client_id',p_client_id,'updated_by',v_actor,'updated_at',v_now);
end;
$$;

revoke all on function agency_ops.set_client_financial_legal_status(uuid,boolean,boolean,text,date,text) from public, anon, authenticated;
grant execute on function agency_ops.set_client_financial_legal_status(uuid,boolean,boolean,text,date,text) to service_role;
