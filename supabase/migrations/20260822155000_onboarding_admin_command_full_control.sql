create table if not exists agency_ops.onboarding_admin_command_audit (
  id bigserial primary key,
  case_id bigint not null references agency_ops.onboarding_cases(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  actor_user_id uuid,
  actor_person text not null,
  command_text text not null,
  patch jsonb not null default '{}'::jsonb,
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists onboarding_admin_command_audit_case_created_idx
  on agency_ops.onboarding_admin_command_audit(case_id, created_at desc);

alter table agency_ops.onboarding_admin_command_audit enable row level security;
revoke all on agency_ops.onboarding_admin_command_audit from anon, authenticated;
grant select, insert on agency_ops.onboarding_admin_command_audit to service_role;
grant usage, select on sequence agency_ops.onboarding_admin_command_audit_id_seq to service_role;

create or replace function agency_ops.apply_onboarding_admin_patch(
  p_case_id bigint,
  p_actor_user_id uuid,
  p_actor_person text,
  p_command text,
  p_patch jsonb
) returns jsonb
language plpgsql
security definer
set search_path='agency_ops','pg_catalog'
as $function$
declare
  v_case agency_ops.onboarding_cases%rowtype;
  v_client agency_ops.clients%rowtype;
  v_case_patch jsonb := coalesce(p_patch->'case','{}'::jsonb);
  v_client_patch jsonb := coalesce(p_patch->'client','{}'::jsonb);
  v_stage_patch jsonb;
  v_meeting_patch jsonb := coalesce(p_patch->'meeting','{}'::jsonb);
  v_stage_code text;
  v_before jsonb;
  v_after jsonb;
  v_audit_id bigint;
  v_recalculate boolean := coalesce((p_patch->>'recalculate')::boolean,false);
  v_previous_internal text := coalesce(current_setting('agency_ops.onboarding_internal_update',true),'off');
begin
  if p_actor_person <> 'Adler Furtado' then raise exception 'ONBOARDING_ADMIN_FORBIDDEN'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'INVALID_PATCH'; end if;

  select * into v_case from agency_ops.onboarding_cases where id=p_case_id for update;
  if not found then raise exception 'ONBOARDING_CASE_NOT_FOUND'; end if;
  select * into v_client from agency_ops.clients where id=v_case.client_id for update;
  if not found then raise exception 'CLIENT_NOT_FOUND'; end if;

  if exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('case','client','stages','meeting','recalculate')) then raise exception 'UNSUPPORTED_PATCH_SECTION'; end if;
  if exists(select 1 from jsonb_object_keys(v_case_patch) k where k not in ('status','current_stage','onboarding_risk','blocked_by','next_action','next_action_due','opened_at','closed_at','creative_input_ready_at','creative_sla_started_at','creative_due_at','metadata_merge')) then raise exception 'UNSUPPORTED_CASE_FIELD'; end if;
  if exists(select 1 from jsonb_object_keys(v_client_patch) k where k not in ('lifecycle','entrada','saida','cs_owner','gt_owner','designer_owner','metadata_merge')) then raise exception 'UNSUPPORTED_CLIENT_FIELD'; end if;

  select jsonb_build_object(
    'case',to_jsonb(v_case),'client',to_jsonb(v_client),
    'stages',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from agency_ops.onboarding_stages s where s.case_id=p_case_id),'[]'::jsonb),
    'meetings',coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from agency_ops.onboarding_stage_meet_links m where m.case_id=p_case_id and m.is_current),'[]'::jsonb)
  ) into v_before;

  perform set_config('agency_ops.onboarding_internal_update','on',true);

  if v_client_patch <> '{}'::jsonb then
    update agency_ops.clients c set
      lifecycle=case when v_client_patch?'lifecycle' then nullif(v_client_patch->>'lifecycle','') else c.lifecycle end,
      entrada=case when v_client_patch?'entrada' then nullif(v_client_patch->>'entrada','')::date else c.entrada end,
      saida=case when v_client_patch?'saida' then nullif(v_client_patch->>'saida','')::date else c.saida end,
      cs_owner=case when v_client_patch?'cs_owner' then nullif(v_client_patch->>'cs_owner','') else c.cs_owner end,
      gt_owner=case when v_client_patch?'gt_owner' then nullif(v_client_patch->>'gt_owner','') else c.gt_owner end,
      designer_owner=case when v_client_patch?'designer_owner' then nullif(v_client_patch->>'designer_owner','') else c.designer_owner end,
      metadata=case when v_client_patch?'metadata_merge' then coalesce(c.metadata,'{}'::jsonb)||coalesce(v_client_patch->'metadata_merge','{}'::jsonb) else c.metadata end,
      updated_at=now()
    where c.id=v_case.client_id;
  end if;

  if v_case_patch <> '{}'::jsonb then
    if v_case_patch?'current_stage' and nullif(v_case_patch->>'current_stage','') is not null
       and not exists(select 1 from agency_ops.onboarding_stages s where s.case_id=p_case_id and s.stage_code=v_case_patch->>'current_stage') then
      raise exception 'CURRENT_STAGE_NOT_IN_CASE';
    end if;
    update agency_ops.onboarding_cases oc set
      status=case when v_case_patch?'status' then nullif(v_case_patch->>'status','') else oc.status end,
      current_stage=case when v_case_patch?'current_stage' then nullif(v_case_patch->>'current_stage','') else oc.current_stage end,
      onboarding_risk=case when v_case_patch?'onboarding_risk' then nullif(v_case_patch->>'onboarding_risk','') else oc.onboarding_risk end,
      blocked_by=case when v_case_patch?'blocked_by' then nullif(v_case_patch->>'blocked_by','') else oc.blocked_by end,
      next_action=case when v_case_patch?'next_action' then nullif(v_case_patch->>'next_action','') else oc.next_action end,
      next_action_due=case when v_case_patch?'next_action_due' then nullif(v_case_patch->>'next_action_due','')::timestamptz else oc.next_action_due end,
      opened_at=case when v_case_patch?'opened_at' then nullif(v_case_patch->>'opened_at','')::timestamptz else oc.opened_at end,
      closed_at=case when v_case_patch?'closed_at' then nullif(v_case_patch->>'closed_at','')::timestamptz else oc.closed_at end,
      creative_input_ready_at=case when v_case_patch?'creative_input_ready_at' then nullif(v_case_patch->>'creative_input_ready_at','')::timestamptz else oc.creative_input_ready_at end,
      creative_sla_started_at=case when v_case_patch?'creative_sla_started_at' then nullif(v_case_patch->>'creative_sla_started_at','')::timestamptz else oc.creative_sla_started_at end,
      creative_due_at=case when v_case_patch?'creative_due_at' then nullif(v_case_patch->>'creative_due_at','')::timestamptz else oc.creative_due_at end,
      metadata=case when v_case_patch?'metadata_merge' then coalesce(oc.metadata,'{}'::jsonb)||coalesce(v_case_patch->'metadata_merge','{}'::jsonb) else oc.metadata end,
      updated_at=now()
    where oc.id=p_case_id;
  end if;

  if p_patch?'stages' then
    if jsonb_typeof(p_patch->'stages')<>'array' then raise exception 'STAGES_MUST_BE_ARRAY'; end if;
    for v_stage_patch in select value from jsonb_array_elements(p_patch->'stages') loop
      if exists(select 1 from jsonb_object_keys(v_stage_patch) k where k not in ('stage_code','status','started_at','completed_at','due_at','blocked_type','notes','append_note','applicability','applicability_source','applicability_source_ref','applicability_evidence','applicability_confidence','applicability_updated_at')) then raise exception 'UNSUPPORTED_STAGE_FIELD'; end if;
      v_stage_code:=nullif(v_stage_patch->>'stage_code','');
      if v_stage_code is null or not exists(select 1 from agency_ops.onboarding_stages where case_id=p_case_id and stage_code=v_stage_code) then raise exception 'ONBOARDING_STAGE_NOT_FOUND'; end if;
      update agency_ops.onboarding_stages s set
        status=case when v_stage_patch?'status' then nullif(v_stage_patch->>'status','') else s.status end,
        started_at=case when v_stage_patch?'started_at' then nullif(v_stage_patch->>'started_at','')::timestamptz else s.started_at end,
        completed_at=case when v_stage_patch?'completed_at' then nullif(v_stage_patch->>'completed_at','')::timestamptz when v_stage_patch->>'status'='DONE' then coalesce(s.completed_at,now()) when v_stage_patch?'status' and v_stage_patch->>'status'<>'DONE' then null else s.completed_at end,
        due_at=case when v_stage_patch?'due_at' then nullif(v_stage_patch->>'due_at','')::timestamptz else s.due_at end,
        blocked_type=case when v_stage_patch?'blocked_type' then nullif(v_stage_patch->>'blocked_type','') when v_stage_patch?'status' and v_stage_patch->>'status'<>'BLOCKED' then null else s.blocked_type end,
        notes=case when v_stage_patch?'notes' then nullif(v_stage_patch->>'notes','') when v_stage_patch?'append_note' then concat_ws(' | ',nullif(s.notes,''),nullif(v_stage_patch->>'append_note','')) else s.notes end,
        applicability=case when v_stage_patch?'applicability' then nullif(v_stage_patch->>'applicability','') else s.applicability end,
        applicability_source=case when v_stage_patch?'applicability_source' then nullif(v_stage_patch->>'applicability_source','') else s.applicability_source end,
        applicability_source_ref=case when v_stage_patch?'applicability_source_ref' then nullif(v_stage_patch->>'applicability_source_ref','') else s.applicability_source_ref end,
        applicability_evidence=case when v_stage_patch?'applicability_evidence' then nullif(v_stage_patch->>'applicability_evidence','') else s.applicability_evidence end,
        applicability_confidence=case when v_stage_patch?'applicability_confidence' then nullif(v_stage_patch->>'applicability_confidence','')::numeric else s.applicability_confidence end,
        applicability_updated_at=case when v_stage_patch?'applicability_updated_at' then nullif(v_stage_patch->>'applicability_updated_at','')::timestamptz when v_stage_patch?'applicability' then now() else s.applicability_updated_at end
      where s.case_id=p_case_id and s.stage_code=v_stage_code;
    end loop;
  end if;

  if v_meeting_patch <> '{}'::jsonb then
    if exists(select 1 from jsonb_object_keys(v_meeting_patch) k where k not in ('stage_code','scheduled_for','url','provider')) then raise exception 'UNSUPPORTED_MEETING_FIELD'; end if;
    v_stage_code:=nullif(v_meeting_patch->>'stage_code',''); if v_stage_code is null then raise exception 'MEETING_STAGE_REQUIRED'; end if;
    if v_meeting_patch?'scheduled_for' then
      update agency_ops.onboarding_stages set due_at=nullif(v_meeting_patch->>'scheduled_for','')::timestamptz,status=case when nullif(v_meeting_patch->>'scheduled_for','') is null then status when status='DONE' then status else 'SCHEDULED' end where case_id=p_case_id and stage_code=v_stage_code;
      update agency_ops.onboarding_stage_meet_links set scheduled_for=nullif(v_meeting_patch->>'scheduled_for','')::timestamptz,updated_at=now() where case_id=p_case_id and stage_code=v_stage_code and is_current;
    end if;
    if nullif(v_meeting_patch->>'url','') is not null then
      update agency_ops.onboarding_stage_meet_links set is_current=false,updated_at=now() where case_id=p_case_id and stage_code=v_stage_code and is_current;
      insert into agency_ops.onboarding_stage_meet_links(case_id,stage_code,url,provider,source,source_id,occurred_at,scheduled_for,is_current,metadata)
      values(p_case_id,v_stage_code,v_meeting_patch->>'url',coalesce(nullif(v_meeting_patch->>'provider',''),'google_meet'),'manual_adler_command','adler-command:'||gen_random_uuid()::text,now(),nullif(v_meeting_patch->>'scheduled_for','')::timestamptz,true,jsonb_build_object('actor',p_actor_person,'command',p_command));
    end if;
  end if;

  if v_recalculate then perform agency_ops.recalculate_onboarding_case(p_case_id); end if;

  select jsonb_build_object(
    'case',to_jsonb(oc),'client',to_jsonb(c),
    'stages',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from agency_ops.onboarding_stages s where s.case_id=p_case_id),'[]'::jsonb),
    'meetings',coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from agency_ops.onboarding_stage_meet_links m where m.case_id=p_case_id and m.is_current),'[]'::jsonb)
  ) into v_after from agency_ops.onboarding_cases oc join agency_ops.clients c on c.id=oc.client_id where oc.id=p_case_id;

  insert into agency_ops.onboarding_admin_command_audit(case_id,client_id,actor_user_id,actor_person,command_text,patch,before_state,after_state)
  values(p_case_id,v_case.client_id,p_actor_user_id,p_actor_person,p_command,p_patch,v_before,v_after) returning id into v_audit_id;
  insert into agency_ops.onboarding_events(case_id,event_type,source,source_id,occurred_at,metadata)
  values(p_case_id,'ADMIN_COMMAND_APPLIED','manual_adler_command','audit:'||v_audit_id::text,now(),jsonb_build_object('audit_id',v_audit_id,'actor_user_id',p_actor_user_id,'actor_person',p_actor_person,'command',p_command,'patch',p_patch));

  perform set_config('agency_ops.onboarding_internal_update',v_previous_internal,true);
  return jsonb_build_object('ok',true,'audit_id',v_audit_id,'before',v_before,'after',v_after);
exception when others then
  perform set_config('agency_ops.onboarding_internal_update',v_previous_internal,true);
  raise;
end;
$function$;

revoke all on function agency_ops.apply_onboarding_admin_patch(bigint,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function agency_ops.apply_onboarding_admin_patch(bigint,uuid,text,text,jsonb) to service_role;
