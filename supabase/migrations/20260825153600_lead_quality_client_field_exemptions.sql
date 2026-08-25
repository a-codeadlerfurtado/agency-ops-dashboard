create table if not exists agency_ops.lead_dispatch_quality_field_exemptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  product_key text not null,
  product_label text,
  field_kind text not null check (field_kind in ('required','extra')),
  field_label text not null,
  reason text not null default 'CLIENT_REQUEST',
  active boolean not null default true,
  created_by_user_key text,
  created_by_person text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(client_id,product_key,field_kind,field_label)
);

create index if not exists lead_dispatch_quality_field_exemptions_lookup_idx
  on agency_ops.lead_dispatch_quality_field_exemptions(client_id,product_key,active);

alter table agency_ops.lead_dispatch_quality_field_exemptions enable row level security;
revoke all on agency_ops.lead_dispatch_quality_field_exemptions from public,anon,authenticated;
grant select,insert,update,delete on agency_ops.lead_dispatch_quality_field_exemptions to service_role;

create or replace function agency_ops.create_lead_dispatch_quality_incident()
returns trigger
language plpgsql
security definer
set search_path=agency_ops,public,pg_catalog
as $$
declare
  v_missing text[] := '{}'::text[];
  v_extra jsonb := '[]'::jsonb;
  v_client uuid;
  v_client_name text;
  v_gt text;
  v_product_key text;
  v_occurrence integer := 1;
  v_severity text := 'ATTENTION';
  v_title text;
  v_description text;
  v_incident_id uuid;
  v_notification_id uuid;
  v_missing_labels text;
  v_recipient_phone text;
begin
  if exists(select 1 from agency_ops.lead_dispatch_quality_incidents where message_id=new.message_id) then
    return new;
  end if;

  -- Leads internos usados por GTs para testar o módulo não devem virar incidente.
  v_recipient_phone := regexp_replace(coalesce(new.recipient_phone,''),'[^0-9]','','g');
  if length(v_recipient_phone) >= 10 and exists (
    select 1
    from agency_ops.team_identity_map tm
    where tm.role='GT'
      and length(regexp_replace(coalesce(tm.whatsapp_phone,''),'[^0-9]','','g')) >= 10
      and regexp_replace(coalesce(tm.whatsapp_phone,''),'[^0-9]','','g') = v_recipient_phone
  ) then
    return new;
  end if;

  if not agency_ops.lead_dispatch_name_valid(new.raw_text) then v_missing := array_append(v_missing,'Nome'); end if;
  if not agency_ops.lead_dispatch_phone_valid(new.raw_text) then v_missing := array_append(v_missing,'Telefone'); end if;
  if not agency_ops.lead_dispatch_email_valid(new.raw_text) then v_missing := array_append(v_missing,'E-mail'); end if;
  v_extra := agency_ops.lead_dispatch_missing_extra_questions(new.raw_text);

  v_client := coalesce(new.recipient_client_id,new.expected_client_id);
  if v_client is not null then
    select display_name,gt_owner into v_client_name,v_gt from agency_ops.clients where id=v_client;
  end if;
  v_product_key := coalesce(nullif(agency_ops.normalize_match_text(new.product_label),''),'sem-produto');

  -- Se o cliente pediu para retirar um campo deste produto, ele deixa de ser
  -- considerado obrigatório para a qualidade do disparo.
  if v_client is not null then
    select coalesce(array_agg(x.field order by x.ord),'{}'::text[])
      into v_missing
    from unnest(v_missing) with ordinality as x(field,ord)
    where not exists (
      select 1
      from agency_ops.lead_dispatch_quality_field_exemptions e
      where e.client_id=v_client
        and e.product_key=v_product_key
        and e.field_kind='required'
        and e.active
        and agency_ops.normalize_match_text(e.field_label)=agency_ops.normalize_match_text(x.field)
    );

    select coalesce(jsonb_agg(x.item order by x.ord),'[]'::jsonb)
      into v_extra
    from jsonb_array_elements(v_extra) with ordinality as x(item,ord)
    where not exists (
      select 1
      from agency_ops.lead_dispatch_quality_field_exemptions e
      where e.client_id=v_client
        and e.product_key=v_product_key
        and e.field_kind='extra'
        and e.active
        and agency_ops.normalize_match_text(e.field_label)=agency_ops.normalize_match_text(x.item->>'question')
    );
  end if;

  if coalesce(cardinality(v_missing),0)=0 and jsonb_array_length(v_extra)=0 then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(coalesce(v_client::text,'sem-cliente')||'|'||v_product_key)::bigint);

  -- A recorrência considera apenas falhas que ainda são válidas. Incidentes
  -- antigos formados somente por campos depois dispensados deixam de inflar a contagem.
  select coalesce(count(*),0)::integer+1 into v_occurrence
  from agency_ops.lead_dispatch_quality_incidents i
  where i.client_id is not distinct from v_client
    and i.product_key=v_product_key
    and (
      exists (
        select 1
        from unnest(i.missing_required) as old_field(field)
        where not exists (
          select 1
          from agency_ops.lead_dispatch_quality_field_exemptions e
          where e.client_id=v_client
            and e.product_key=v_product_key
            and e.field_kind='required'
            and e.active
            and agency_ops.normalize_match_text(e.field_label)=agency_ops.normalize_match_text(old_field.field)
        )
      )
      or exists (
        select 1
        from jsonb_array_elements(i.missing_extra_questions) as old_extra(item)
        where not exists (
          select 1
          from agency_ops.lead_dispatch_quality_field_exemptions e
          where e.client_id=v_client
            and e.product_key=v_product_key
            and e.field_kind='extra'
            and e.active
            and agency_ops.normalize_match_text(e.field_label)=agency_ops.normalize_match_text(old_extra.item->>'question')
        )
      )
    );

  v_severity := case when v_occurrence >= 2 then 'CRITICAL' else 'ATTENTION' end;
  v_missing_labels := array_to_string(v_missing,', ');
  if jsonb_array_length(v_extra)>0 then
    v_missing_labels := concat_ws(', ',nullif(v_missing_labels,''),jsonb_array_length(v_extra)||' pergunta(s) sem resposta');
  end if;

  v_title := case
    when v_occurrence=1 then 'Lead incompleto enviado ao cliente'
    when v_occurrence=2 then '2ª ocorrência — lead incompleto no mesmo produto'
    else v_occurrence||'ª ocorrência recorrente — lead incompleto'
  end;
  v_description := coalesce(v_client_name,'Cliente não identificado')||' · '||coalesce(new.product_label,'Produto não identificado')||' · Ausência/inconsistência: '||coalesce(v_missing_labels,'campo incompleto');

  insert into agency_ops.lead_dispatch_quality_incidents(
    dispatch_id,message_id,client_id,client_name,target_gt,product_label,product_key,
    missing_required,missing_extra_questions,occurrence_no,severity,status,raw_text
  ) values (
    new.id,new.message_id,v_client,v_client_name,v_gt,new.product_label,v_product_key,
    v_missing,v_extra,v_occurrence,v_severity,'OPEN',new.raw_text
  ) returning id into v_incident_id;

  insert into agency_ops.platform_notifications(
    event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata
  ) values (
    'lead-dispatch-quality:'||new.message_id,
    'LEAD_DISPATCH_INCOMPLETE',v_severity,v_title,v_description,v_client,
    'zapi_direct_official','Sistema',coalesce(new.event_at,now()),
    jsonb_build_object(
      'incident_id',v_incident_id,
      'message_id',new.message_id,
      'target_role','GT',
      'target_person',v_gt,
      'product_label',new.product_label,
      'occurrence_no',v_occurrence,
      'recurrent',v_occurrence>=2,
      'missing_required',to_jsonb(v_missing),
      'missing_extra_questions',v_extra,
      'raw_text',left(coalesce(new.raw_text,''),6000),
      'routing_status',new.routing_status
    )
  ) on conflict(event_key) do update set
    level=excluded.level,title=excluded.title,description=excluded.description,metadata=excluded.metadata
  returning id into v_notification_id;

  update agency_ops.lead_dispatch_quality_incidents
  set notification_id=v_notification_id,updated_at=now()
  where id=v_incident_id;

  return new;
end;
$$;
