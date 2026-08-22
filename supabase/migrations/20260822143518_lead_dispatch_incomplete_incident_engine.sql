create table if not exists agency_ops.lead_dispatch_quality_incidents (
  id uuid primary key default gen_random_uuid(),
  dispatch_id bigint not null unique references agency_ops.meta_lead_dispatches(id) on delete cascade,
  message_id text not null unique,
  client_id uuid references agency_ops.clients(id) on delete set null,
  client_name text,
  target_gt text,
  product_label text,
  product_key text not null,
  missing_required text[] not null default '{}'::text[],
  missing_extra_questions jsonb not null default '[]'::jsonb,
  occurrence_no integer not null default 1,
  severity text not null check (severity in ('ATTENTION','CRITICAL')),
  status text not null default 'OPEN' check (status in ('OPEN','ACKNOWLEDGED','RESOLVED')),
  notification_id uuid references agency_ops.platform_notifications(id) on delete set null,
  raw_text text,
  acknowledged_by_user_key text,
  acknowledged_by_person text,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lead_dispatch_quality_incidents_target_idx
  on agency_ops.lead_dispatch_quality_incidents(target_gt,status,created_at desc);
create index if not exists lead_dispatch_quality_incidents_recurrence_idx
  on agency_ops.lead_dispatch_quality_incidents(client_id,product_key,created_at desc);

create or replace function agency_ops.lead_dispatch_field_value(p_text text, p_label text)
returns text
language plpgsql
immutable
set search_path=pg_catalog
as $$
declare
  v_line text;
  v_trim text;
  v_pos integer;
begin
  if p_text is null or p_label is null then return null; end if;
  for v_line in select regexp_split_to_table(replace(p_text,E'\r',''),E'\n') loop
    v_trim := btrim(v_line);
    if upper(v_trim) like upper(p_label)||':%' then
      v_pos := strpos(v_trim,':');
      if v_pos > 0 then return nullif(btrim(substr(v_trim,v_pos+1)),''); end if;
    end if;
  end loop;
  return null;
end;
$$;

create or replace function agency_ops.lead_dispatch_value_missing(p_value text)
returns boolean
language sql
immutable
set search_path=pg_catalog
as $$
  select p_value is null or lower(btrim(p_value)) in ('','-','--','n/a','na','null','undefined','sem resposta','não informado','nao informado','não respondeu','nao respondeu');
$$;

create or replace function agency_ops.lead_dispatch_phone_valid(p_text text)
returns boolean
language plpgsql
immutable
set search_path=agency_ops,pg_catalog
as $$
declare
  v_value text;
  v_match text[];
  v_digits text;
begin
  v_value := agency_ops.lead_dispatch_field_value(p_text,'TELEFONE');
  if agency_ops.lead_dispatch_value_missing(v_value) then return false; end if;
  for v_match in select regexp_matches(v_value,'([+]?[0-9][0-9 ().-]{8,}[0-9])','g') loop
    v_digits := regexp_replace(v_match[1],'[^0-9]','','g');
    if length(v_digits) between 10 and 15 then return true; end if;
  end loop;
  v_digits := regexp_replace(coalesce(v_value,''),'[^0-9]','','g');
  return length(v_digits) between 10 and 15;
end;
$$;

create or replace function agency_ops.lead_dispatch_email_valid(p_text text)
returns boolean
language plpgsql
immutable
set search_path=agency_ops,pg_catalog
as $$
declare v text;
begin
  v := agency_ops.lead_dispatch_field_value(p_text,'EMAIL');
  if agency_ops.lead_dispatch_value_missing(v) then return false; end if;
  return v ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
end;
$$;

create or replace function agency_ops.lead_dispatch_name_valid(p_text text)
returns boolean
language plpgsql
immutable
set search_path=agency_ops,pg_catalog
as $$
declare v text;
begin
  v := agency_ops.lead_dispatch_field_value(p_text,'NOME DO LEAD');
  if agency_ops.lead_dispatch_value_missing(v) then return false; end if;
  if upper(v) like 'TELEFONE:%' or upper(v) like 'EMAIL:%' then return false; end if;
  return length(btrim(v)) >= 2;
end;
$$;

create or replace function agency_ops.lead_dispatch_missing_extra_questions(p_text text)
returns jsonb
language plpgsql
immutable
set search_path=agency_ops,pg_catalog
as $$
declare
  v_lines text[];
  v_result jsonb := '[]'::jsonb;
  i integer;
  j integer;
  v_line text;
  v_next text;
  v_email_seen boolean := false;
  v_is_question boolean;
begin
  if p_text is null then return v_result; end if;
  v_lines := regexp_split_to_array(replace(p_text,E'\r',''),E'\n');
  if v_lines is null then return v_result; end if;

  i := 1;
  while i <= array_length(v_lines,1) loop
    v_line := btrim(coalesce(v_lines[i],''));
    if upper(v_line) like 'EMAIL:%' then
      v_email_seen := true;
      i := i + 1;
      continue;
    end if;
    if not v_email_seen or v_line='' then
      i := i + 1;
      continue;
    end if;

    v_is_question := (right(v_line,1)='?') or (v_line ~ '^[0-9]+[.)][[:space:]]+.+');
    if v_is_question then
      j := i + 1;
      v_next := null;
      while j <= array_length(v_lines,1) loop
        if btrim(coalesce(v_lines[j],''))<>'' then
          v_next := btrim(v_lines[j]);
          exit;
        end if;
        j := j + 1;
      end loop;

      if v_next is null
         or right(v_next,1)='?'
         or v_next ~ '^[0-9]+[.)][[:space:]]+.+\??$'
         or upper(v_next) like 'NOME DO LEAD:%'
         or upper(v_next) like 'TELEFONE:%'
         or upper(v_next) like 'EMAIL:%'
         or agency_ops.lead_dispatch_value_missing(v_next) then
        v_result := v_result || jsonb_build_array(jsonb_build_object('question',v_line,'line',i));
      end if;
    end if;
    i := i + 1;
  end loop;
  return v_result;
end;
$$;

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
begin
  if exists(select 1 from agency_ops.lead_dispatch_quality_incidents where message_id=new.message_id) then
    return new;
  end if;

  if not agency_ops.lead_dispatch_name_valid(new.raw_text) then v_missing := array_append(v_missing,'Nome'); end if;
  if not agency_ops.lead_dispatch_phone_valid(new.raw_text) then v_missing := array_append(v_missing,'Telefone'); end if;
  if not agency_ops.lead_dispatch_email_valid(new.raw_text) then v_missing := array_append(v_missing,'E-mail'); end if;
  v_extra := agency_ops.lead_dispatch_missing_extra_questions(new.raw_text);

  if coalesce(cardinality(v_missing),0)=0 and jsonb_array_length(v_extra)=0 then
    return new;
  end if;

  v_client := coalesce(new.recipient_client_id,new.expected_client_id);
  if v_client is not null then
    select display_name,gt_owner into v_client_name,v_gt from agency_ops.clients where id=v_client;
  end if;
  v_product_key := coalesce(nullif(agency_ops.normalize_match_text(new.product_label),''),'sem-produto');

  perform pg_advisory_xact_lock(hashtext(coalesce(v_client::text,'sem-cliente')||'|'||v_product_key)::bigint);
  select coalesce(max(occurrence_no),0)+1 into v_occurrence
  from agency_ops.lead_dispatch_quality_incidents
  where client_id is not distinct from v_client and product_key=v_product_key;

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

drop trigger if exists trg_lead_dispatch_quality_incident on agency_ops.meta_lead_dispatches;
create trigger trg_lead_dispatch_quality_incident
after insert or update of raw_text,lead_name,lead_phone,lead_email,recipient_client_id,expected_client_id,product_label
on agency_ops.meta_lead_dispatches
for each row execute function agency_ops.create_lead_dispatch_quality_incident();

alter table agency_ops.lead_dispatch_quality_incidents enable row level security;
revoke all on agency_ops.lead_dispatch_quality_incidents from public,anon,authenticated;
grant select,insert,update,delete on agency_ops.lead_dispatch_quality_incidents to service_role;
