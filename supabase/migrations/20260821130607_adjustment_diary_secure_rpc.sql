-- Novos registros do Diario precisam ser estruturados. Legados auditados podem permanecer incompletos.
alter table agency_ops.client_adjustments drop constraint if exists client_adjustments_structured_required;
alter table agency_ops.client_adjustments add constraint client_adjustments_structured_required check (
  status='LEGACY_UNKNOWN' or (
    author_user_id is not null and category_code is not null and subcategory_code is not null
    and nullif(btrim(coalesce(descricao,'')),'') is not null
    and nullif(btrim(coalesce(reason,'')),'') is not null
    and request_origin is not null
  )
);

create or replace function agency_ops.diary_get(
  p_actor uuid,
  p_scope text default 'mine',
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,agency_ops
as $$
declare
  v_admin boolean := false;
  v_person text;
  v_role text;
  v_since date;
  v_until date;
  v_adjustments jsonb;
  v_tasklog jsonb;
  v_clients jsonb;
  v_categories jsonb;
  v_subcategories jsonb;
  v_staff jsonb;
begin
  if p_actor is null then raise exception 'diary_unauthorized'; end if;
  select exists(select 1 from agency_ops.diary_admin_users d where d.user_id=p_actor) into v_admin;
  select coalesce(up.collaborator_person,up.name),tr.role
    into v_person,v_role
  from agency_ops.user_preferences up
  left join agency_ops.team_roster tr on tr.person=coalesce(up.collaborator_person,up.name) and not tr.is_former
  where up.user_key=p_actor::text
  limit 1;
  if v_person is null and not v_admin then raise exception 'diary_profile_required'; end if;
  if p_scope not in ('mine','all') then raise exception 'diary_invalid_scope'; end if;
  if p_scope='all' and not v_admin then raise exception 'diary_forbidden'; end if;
  if coalesce(p_filters->>'since','') ~ '^\d{4}-\d{2}-\d{2}$' then v_since=(p_filters->>'since')::date; end if;
  if coalesce(p_filters->>'until','') ~ '^\d{4}-\d{2}-\d{2}$' then v_until=(p_filters->>'until')::date; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.occurred_at desc,x.id desc),'[]'::jsonb) into v_adjustments
  from (
    select ca.id,ca.client_id,c.display_name as client_display_name,ca.author_user_id,
      coalesce(up.collaborator_person,up.name,ca.author_name_snapshot,ca.metadata->>'author_name','Autor não identificado') as author_name,
      ca.category_code,cat.label as category_label,ca.subcategory_code,sub.label as subcategory_label,
      ca.descricao as description,ca.reason,ca.request_origin,ca.requested_by_user_id,ca.responsible_area,
      ca.status,ca.severity,ca.resolution,ca.is_recurrent,ca.parent_adjustment_id,
      ca.occurred_at,ca.created_at,ca.updated_at,ca.resolved_at,ca.source,
      ca.clickup_task_id,ca.campaign_id,ca.creative_id,ca.request_id,ca.tasklog_id
    from agency_ops.client_adjustments ca
    left join agency_ops.clients c on c.id=ca.client_id
    left join agency_ops.user_preferences up on up.user_key=ca.author_user_id::text
    left join agency_ops.adjustment_categories cat on cat.code=ca.category_code
    left join agency_ops.adjustment_subcategories sub on sub.code=ca.subcategory_code
    where (p_scope='all' or ca.author_user_id=p_actor)
      and (coalesce(p_filters->>'author_user_id','')='' or
           (p_filters->>'author_user_id'='UNKNOWN' and ca.author_user_id is null) or
           ca.author_user_id::text=p_filters->>'author_user_id')
      and (coalesce(p_filters->>'client_id','')='' or ca.client_id::text=p_filters->>'client_id')
      and (coalesce(p_filters->>'category_code','')='' or ca.category_code=p_filters->>'category_code')
      and (coalesce(p_filters->>'subcategory_code','')='' or ca.subcategory_code=p_filters->>'subcategory_code')
      and (coalesce(p_filters->>'responsible_area','')='' or ca.responsible_area=p_filters->>'responsible_area')
      and (coalesce(p_filters->>'status','')='' or ca.status=p_filters->>'status')
      and (v_since is null or ca.occurred_at >= (v_since::timestamp at time zone 'America/Sao_Paulo'))
      and (v_until is null or ca.occurred_at < ((v_until+1)::timestamp at time zone 'America/Sao_Paulo'))
    order by ca.occurred_at desc,ca.id desc
    limit 1000
  ) x;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.task_date desc,x.created_at_client desc),'[]'::jsonb) into v_tasklog
  from (
    select tle.id,tle.author_user_id,tle.user_key,tle.collaborator_name,tle.category,tle.task_name,tle.task_date,tle.created_at_client,tle.source,tle.synced_at
    from agency_ops.task_log_entries tle
    where tle.deleted_at is null
      and (p_scope='all' or tle.author_user_id=p_actor or (tle.author_user_id is null and tle.user_key=p_actor::text))
      and (coalesce(p_filters->>'author_user_id','')='' or tle.author_user_id::text=p_filters->>'author_user_id')
      and (v_since is null or tle.task_date>=v_since)
      and (v_until is null or tle.task_date<=v_until)
    order by tle.task_date desc,tle.created_at_client desc
    limit 1000
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('client_id',c.id,'display_name',c.display_name) order by c.display_name),'[]'::jsonb) into v_clients
  from agency_ops.clients c
  where c.lifecycle in ('ACTIVE','ONBOARDING')
    and (v_admin or v_role not in ('GT','CS') or (v_role='GT' and c.gt_owner=v_person) or (v_role='CS' and c.cs_owner=v_person));

  select coalesce(jsonb_agg(jsonb_build_object('code',code,'label',label,'sort_order',sort_order) order by sort_order,label),'[]'::jsonb) into v_categories
  from agency_ops.adjustment_categories where active;
  select coalesce(jsonb_agg(jsonb_build_object('code',code,'category_code',category_code,'label',label,'sort_order',sort_order) order by category_code,sort_order,label),'[]'::jsonb) into v_subcategories
  from agency_ops.adjustment_subcategories where active;

  if v_admin then
    select coalesce(jsonb_agg(jsonb_build_object('user_id',au.id,'person',coalesce(up.collaborator_person,up.name)) order by coalesce(up.collaborator_person,up.name)),'[]'::jsonb) into v_staff
    from agency_ops.user_preferences up join auth.users au on au.id::text=up.user_key
    where coalesce(up.collaborator_person,up.name) is not null;
  else
    v_staff='[]'::jsonb;
  end if;

  return jsonb_build_object(
    'scope',p_scope,'can_view_all',v_admin,'actor',jsonb_build_object('user_id',p_actor,'person',v_person,'role',v_role),
    'adjustments',v_adjustments,'task_log',v_tasklog,'clients',v_clients,
    'categories',v_categories,'subcategories',v_subcategories,'staff',v_staff,
    'counts',jsonb_build_object('adjustments',jsonb_array_length(v_adjustments),'tasks',jsonb_array_length(v_tasklog)),
    'generated_at',now()
  );
end;
$$;

create or replace function agency_ops.diary_create_adjustment(p_actor uuid,p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,agency_ops
as $$
declare
  v_person text; v_role text; v_admin boolean; v_client uuid; v_category text; v_subcategory text;
  v_description text; v_reason text; v_origin text; v_occurred timestamptz; v_status text; v_severity text; v_area text;
  v_category_label text; v_requested uuid; v_parent bigint; v_row agency_ops.client_adjustments%rowtype;
begin
  if p_actor is null then raise exception 'diary_unauthorized'; end if;
  select exists(select 1 from agency_ops.diary_admin_users where user_id=p_actor) into v_admin;
  select coalesce(up.collaborator_person,up.name),tr.role into v_person,v_role
  from agency_ops.user_preferences up left join agency_ops.team_roster tr on tr.person=coalesce(up.collaborator_person,up.name) and not tr.is_former
  where up.user_key=p_actor::text limit 1;
  if v_person is null and not v_admin then raise exception 'diary_profile_required'; end if;
  begin v_client=(p_payload->>'client_id')::uuid; exception when others then raise exception 'diary_client_required'; end;
  select c.id into v_client from agency_ops.clients c where c.id=v_client and c.lifecycle in ('ACTIVE','ONBOARDING')
    and (v_admin or v_role not in ('GT','CS') or (v_role='GT' and c.gt_owner=v_person) or (v_role='CS' and c.cs_owner=v_person));
  if v_client is null then raise exception 'diary_client_forbidden'; end if;
  v_category=nullif(btrim(p_payload->>'category_code'),''); v_subcategory=nullif(btrim(p_payload->>'subcategory_code'),'');
  select label into v_category_label from agency_ops.adjustment_categories where code=v_category and active;
  if v_category_label is null then raise exception 'diary_category_required'; end if;
  if not exists(select 1 from agency_ops.adjustment_subcategories where code=v_subcategory and category_code=v_category and active) then raise exception 'diary_subcategory_required'; end if;
  v_description=nullif(btrim(p_payload->>'description'),''); v_reason=nullif(btrim(p_payload->>'reason'),''); v_origin=nullif(btrim(p_payload->>'request_origin'),'');
  if v_description is null then raise exception 'diary_description_required'; end if;
  if v_reason is null then raise exception 'diary_reason_required'; end if;
  if v_origin is null or v_origin not in ('CLIENT','CS','GT','DESIGN','OPS','COMMERCIAL','INTERNAL_AUDIT','OTHER') then raise exception 'diary_origin_required'; end if;
  begin v_occurred=(p_payload->>'occurred_at')::timestamptz; exception when others then raise exception 'diary_occurred_at_required'; end;
  v_status=coalesce(nullif(p_payload->>'status',''),'OPEN'); if v_status not in ('OPEN','IN_PROGRESS','RESOLVED','DISCARDED') then raise exception 'diary_invalid_status'; end if;
  v_severity=nullif(p_payload->>'severity',''); if v_severity is not null and v_severity not in ('LOW','MEDIUM','HIGH','CRITICAL') then raise exception 'diary_invalid_severity'; end if;
  v_area=nullif(p_payload->>'responsible_area',''); if v_area is not null and v_area not in ('DESIGN','TRAFFIC','CS','OPS','COMMERCIAL','DEVELOPMENT','CLIENT','EXTERNAL') then raise exception 'diary_invalid_area'; end if;
  if coalesce(p_payload->>'requested_by_user_id','') ~* '^[0-9a-f-]{36}$' then begin v_requested=(p_payload->>'requested_by_user_id')::uuid; exception when others then v_requested=null; end; end if;
  if coalesce(p_payload->>'parent_adjustment_id','') ~ '^\d+$' then v_parent=(p_payload->>'parent_adjustment_id')::bigint; end if;

  insert into agency_ops.client_adjustments(
    client_id,source,tipo,descricao,occurred_at,metadata,author_user_id,author_name_snapshot,category_code,subcategory_code,reason,request_origin,
    requested_by_user_id,responsible_area,status,severity,resolution,is_recurrent,parent_adjustment_id,created_at,updated_at,resolved_at,created_by,updated_by,
    clickup_task_id,campaign_id,creative_id,request_id,tasklog_id
  ) values (
    v_client,'dashboard',v_category_label,left(v_description,4000),v_occurred,
    jsonb_build_object('author_user_key',p_actor::text,'author_name',v_person,'origem','dashboard','schema_version',2),
    p_actor,v_person,v_category,v_subcategory,left(v_reason,4000),v_origin,v_requested,v_area,v_status,v_severity,
    nullif(left(coalesce(p_payload->>'resolution',''),4000),''),coalesce((p_payload->>'is_recurrent')::boolean,false),v_parent,now(),now(),case when v_status='RESOLVED' then now() else null end,p_actor,p_actor,
    nullif(p_payload->>'clickup_task_id',''),nullif(p_payload->>'campaign_id',''),nullif(p_payload->>'creative_id',''),nullif(p_payload->>'request_id',''),nullif(p_payload->>'tasklog_id','')
  ) returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

create or replace function agency_ops.diary_update_adjustment(p_actor uuid,p_id bigint,p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,agency_ops
as $$
declare v_admin boolean; v_current agency_ops.client_adjustments%rowtype; v_status text;
begin
  if p_actor is null then raise exception 'diary_unauthorized'; end if;
  select exists(select 1 from agency_ops.diary_admin_users where user_id=p_actor) into v_admin;
  select * into v_current from agency_ops.client_adjustments where id=p_id;
  if not found then raise exception 'diary_not_found'; end if;
  if not v_admin and v_current.author_user_id is distinct from p_actor then raise exception 'diary_forbidden'; end if;
  v_status=case when p_patch ? 'status' then p_patch->>'status' else v_current.status end;
  if v_status not in ('OPEN','IN_PROGRESS','RESOLVED','DISCARDED') then raise exception 'diary_invalid_status'; end if;
  update agency_ops.client_adjustments set
    status=v_status,
    severity=case when p_patch ? 'severity' then nullif(p_patch->>'severity','') else severity end,
    responsible_area=case when p_patch ? 'responsible_area' then nullif(p_patch->>'responsible_area','') else responsible_area end,
    resolution=case when p_patch ? 'resolution' then nullif(left(p_patch->>'resolution',4000),'') else resolution end,
    is_recurrent=case when p_patch ? 'is_recurrent' then coalesce((p_patch->>'is_recurrent')::boolean,false) else is_recurrent end,
    resolved_at=case when v_status='RESOLVED' then coalesce(resolved_at,now()) when status='RESOLVED' and v_status<>'RESOLVED' then null else resolved_at end,
    updated_at=now(),updated_by=p_actor
  where id=p_id returning * into v_current;
  return to_jsonb(v_current);
end;
$$;

create or replace function agency_ops.diary_create_tasklog(p_actor uuid,p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,agency_ops
as $$
declare v_person text; v_category text; v_name text; v_date date; v_id text; v_row agency_ops.task_log_entries%rowtype;
begin
  if p_actor is null then raise exception 'diary_unauthorized'; end if;
  select coalesce(collaborator_person,name) into v_person from agency_ops.user_preferences where user_key=p_actor::text limit 1;
  if v_person is null then raise exception 'diary_profile_required'; end if;
  v_category=nullif(btrim(p_payload->>'category'),''); v_name=nullif(btrim(p_payload->>'task_name'),'');
  if v_category is null or v_name is null then raise exception 'tasklog_fields_required'; end if;
  begin v_date=coalesce(nullif(p_payload->>'task_date','')::date,(now() at time zone 'America/Sao_Paulo')::date); exception when others then v_date=(now() at time zone 'America/Sao_Paulo')::date; end;
  v_id='dash-'||p_actor::text||'-'||floor(extract(epoch from clock_timestamp())*1000)::bigint::text||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,8);
  insert into agency_ops.task_log_entries(id,user_key,collaborator_name,category,task_name,task_date,created_at_client,source,author_user_id)
  values(v_id,p_actor::text,v_person,left(v_category,120),left(v_name,500),v_date,now(),'dashboard_diario',p_actor)
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke all on function agency_ops.diary_get(uuid,text,jsonb),agency_ops.diary_create_adjustment(uuid,jsonb),agency_ops.diary_update_adjustment(uuid,bigint,jsonb),agency_ops.diary_create_tasklog(uuid,jsonb) from public,anon,authenticated;
grant execute on function agency_ops.diary_get(uuid,text,jsonb),agency_ops.diary_create_adjustment(uuid,jsonb),agency_ops.diary_update_adjustment(uuid,bigint,jsonb),agency_ops.diary_create_tasklog(uuid,jsonb) to service_role;

-- A API antiga usa service_role e consultava registros globais. Retirar SELECT impede
-- vazamento pelo payload legado; o novo endpoint acessa somente as RPCs acima.
revoke select on agency_ops.client_adjustments,agency_ops.task_log_entries from service_role;
