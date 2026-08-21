-- Fechamento das regras 43/44: todos os caminhos antigos preservam autoria por UUID.

create or replace function agency_ops.tasklog_fill_author_user_id()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,agency_ops
as $$
declare
  v_user uuid;
begin
  if new.author_user_id is null and coalesce(new.user_key,'') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    begin
      v_user := new.user_key::uuid;
    exception when others then
      v_user := null;
    end;
    if v_user is not null and exists(select 1 from auth.users u where u.id=v_user) then
      new.author_user_id := v_user;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tasklog_fill_author on agency_ops.task_log_entries;
create trigger trg_tasklog_fill_author
before insert or update of user_key,author_user_id on agency_ops.task_log_entries
for each row execute function agency_ops.tasklog_fill_author_user_id();

update agency_ops.task_log_entries tle
set author_user_id=au.id
from auth.users au
where tle.author_user_id is null and au.id::text=tle.user_key;

-- Diario pessoal nao faz parte da base geral disponibilizada ao leitor SQL da IA.
-- A visao administrativa continua exclusivamente pelo diary_get, validado como Adler.
revoke select on agency_ops.client_adjustments,agency_ops.task_log_entries from agency_ops_ai_reader;

-- Data do ajuste e obrigatoria no backend, nao apenas no formulario.
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
  from agency_ops.user_preferences up
  left join agency_ops.team_roster tr on tr.person=coalesce(up.collaborator_person,up.name) and not tr.is_former
  where up.user_key=p_actor::text limit 1;
  if v_person is null and not v_admin then raise exception 'diary_profile_required'; end if;

  begin v_client=(p_payload->>'client_id')::uuid; exception when others then raise exception 'diary_client_required'; end;
  select c.id into v_client from agency_ops.clients c
  where c.id=v_client and c.lifecycle in ('ACTIVE','ONBOARDING')
    and (v_admin or v_role not in ('GT','CS') or (v_role='GT' and c.gt_owner=v_person) or (v_role='CS' and c.cs_owner=v_person));
  if v_client is null then raise exception 'diary_client_forbidden'; end if;

  v_category=nullif(btrim(p_payload->>'category_code'),'');
  v_subcategory=nullif(btrim(p_payload->>'subcategory_code'),'');
  select label into v_category_label from agency_ops.adjustment_categories where code=v_category and active;
  if v_category_label is null then raise exception 'diary_category_required'; end if;
  if not exists(select 1 from agency_ops.adjustment_subcategories where code=v_subcategory and category_code=v_category and active) then
    raise exception 'diary_subcategory_required';
  end if;

  v_description=nullif(btrim(p_payload->>'description'),'');
  v_reason=nullif(btrim(p_payload->>'reason'),'');
  v_origin=nullif(btrim(p_payload->>'request_origin'),'');
  if v_description is null then raise exception 'diary_description_required'; end if;
  if v_reason is null then raise exception 'diary_reason_required'; end if;
  if v_origin is null or v_origin not in ('CLIENT','CS','GT','DESIGN','OPS','COMMERCIAL','INTERNAL_AUDIT','OTHER') then
    raise exception 'diary_origin_required';
  end if;

  if nullif(btrim(coalesce(p_payload->>'occurred_at','')),'') is null then raise exception 'diary_occurred_at_required'; end if;
  begin v_occurred=(p_payload->>'occurred_at')::timestamptz; exception when others then raise exception 'diary_occurred_at_required'; end;
  if v_occurred is null then raise exception 'diary_occurred_at_required'; end if;

  v_status=coalesce(nullif(p_payload->>'status',''),'OPEN');
  if v_status not in ('OPEN','IN_PROGRESS','RESOLVED','DISCARDED') then raise exception 'diary_invalid_status'; end if;
  v_severity=nullif(p_payload->>'severity','');
  if v_severity is not null and v_severity not in ('LOW','MEDIUM','HIGH','CRITICAL') then raise exception 'diary_invalid_severity'; end if;
  v_area=nullif(p_payload->>'responsible_area','');
  if v_area is not null and v_area not in ('DESIGN','TRAFFIC','CS','OPS','COMMERCIAL','DEVELOPMENT','CLIENT','EXTERNAL') then raise exception 'diary_invalid_area'; end if;
  if coalesce(p_payload->>'requested_by_user_id','') ~* '^[0-9a-f-]{36}$' then
    begin v_requested=(p_payload->>'requested_by_user_id')::uuid; exception when others then v_requested=null; end;
  end if;
  if coalesce(p_payload->>'parent_adjustment_id','') ~ '^\d+$' then v_parent=(p_payload->>'parent_adjustment_id')::bigint; end if;

  insert into agency_ops.client_adjustments(
    client_id,source,tipo,descricao,occurred_at,metadata,author_user_id,author_name_snapshot,category_code,subcategory_code,reason,request_origin,
    requested_by_user_id,responsible_area,status,severity,resolution,is_recurrent,parent_adjustment_id,created_at,updated_at,resolved_at,created_by,updated_by,
    clickup_task_id,campaign_id,creative_id,request_id,tasklog_id
  ) values (
    v_client,'dashboard',v_category_label,left(v_description,4000),v_occurred,
    jsonb_build_object('author_user_key',p_actor::text,'author_name',v_person,'origem','dashboard','schema_version',2),
    p_actor,v_person,v_category,v_subcategory,left(v_reason,4000),v_origin,v_requested,v_area,v_status,v_severity,
    nullif(left(coalesce(p_payload->>'resolution',''),4000),''),coalesce((p_payload->>'is_recurrent')::boolean,false),v_parent,
    now(),now(),case when v_status='RESOLVED' then now() else null end,p_actor,p_actor,
    nullif(p_payload->>'clickup_task_id',''),nullif(p_payload->>'campaign_id',''),nullif(p_payload->>'creative_id',''),nullif(p_payload->>'request_id',''),nullif(p_payload->>'tasklog_id','')
  ) returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke all on function agency_ops.tasklog_fill_author_user_id() from public,anon,authenticated;
revoke all on function agency_ops.diary_create_adjustment(uuid,jsonb) from public,anon,authenticated;
grant execute on function agency_ops.diary_create_adjustment(uuid,jsonb) to service_role;
