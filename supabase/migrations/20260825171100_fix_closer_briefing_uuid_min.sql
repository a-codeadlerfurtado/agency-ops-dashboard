create or replace function agency_ops.tg_enqueue_closer_briefing_client()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','agency_ops','crm','public','extensions'
as $$
declare
  v_crm_lead_id uuid;
  v_won_event_id uuid;
  v_match_count integer := 0;
  v_lead record;
begin
  if new.lifecycle in ('ONBOARDING','ACTIVE') and (
       tg_op='INSERT'
       or old.lifecycle is distinct from new.lifecycle
       or old.display_name is distinct from new.display_name
  ) then
    v_crm_lead_id := new.crm_lead_id;

    if v_crm_lead_id is null then
      -- PostgreSQL não oferece min(uuid) nesta versão. Como o ID só é usado
      -- quando há exatamente 1 correspondência, o cast para text é seguro.
      select min(l.id::text)::uuid, count(*)
        into v_crm_lead_id, v_match_count
        from crm.leads l
       where lower(coalesce(l.stage,''))='fechado'
         and l.archived_at is null
         and not agency_ops.is_synthetic_crm_lead_name(l.name)
         and agency_ops.normalize_name(coalesce(nullif(l.company,''),l.name))
             = agency_ops.normalize_name(coalesce(new.normalized_name,new.display_name));
      if v_match_count <> 1 then
        v_crm_lead_id := null;
      end if;
    end if;

    if v_crm_lead_id is not null then
      select l.* into v_lead from crm.leads l where l.id=v_crm_lead_id;

      update agency_ops.clients
         set crm_lead_id=v_crm_lead_id,
             updated_at=now()
       where id=new.id
         and crm_lead_id is null;

      insert into agency_ops.client_won_events(
        dedupe_key,client_id,occurred_at,initial_source,crm_lead_id,confidence,
        evidence,event_status,metadata,updated_at
      )
      values (
        'crm:'||v_crm_lead_id,
        new.id,
        coalesce(v_lead.closed_at,v_lead.updated_at,now()),
        'CRM Comercial',
        v_crm_lead_id,
        'CONFIRMED',
        jsonb_build_array(jsonb_build_object(
          'source','CRM Comercial',
          'stage',v_lead.stage,
          'at',coalesce(v_lead.closed_at,v_lead.updated_at,now()),
          'lead_name',coalesce(nullif(v_lead.company,''),v_lead.name)
        )),
        'CONFIRMED',
        jsonb_build_object('linked_by','CLIENT_ACTIVATION','capture_version','crm_won_briefing_repair_v1'),
        now()
      )
      on conflict (dedupe_key) do update set
        client_id=excluded.client_id,
        event_status='CONFIRMED',
        metadata=coalesce(agency_ops.client_won_events.metadata,'{}'::jsonb)||excluded.metadata,
        updated_at=now()
      returning id into v_won_event_id;

      perform agency_ops.enqueue_closer_briefing_for_client(new.id,'CRM_WON',v_won_event_id);
    else
      perform agency_ops.enqueue_closer_briefing_for_client(new.id,'CLIENT_LIFECYCLE',null);
    end if;
  end if;
  return new;
end;
$$;
