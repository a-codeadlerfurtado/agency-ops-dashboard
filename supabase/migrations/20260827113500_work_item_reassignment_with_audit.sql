-- Reatribuicao transacional da Central de Trabalho.
-- Mantem o mesmo work_item, preserva todo o contexto e registra a cadeia de responsaveis.

create or replace function agency_ops.normalize_work_item_role_scope()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $function$
declare
  v_role text;
  v_gt text;
begin
  -- Atribuicao nominal e' a fonte de verdade. Isso permite corrigir uma demanda
  -- enviada para a pessoa errada sem alterar a carteira do cliente.
  if nullif(btrim(coalesce(new.target_person,'')), '') is not null then
    select tr.role into v_role
    from agency_ops.team_roster tr
    where tr.person = new.target_person
      and tr.is_former = false
    limit 1;

    if v_role is null then
      raise exception 'WORK_ITEM_ASSIGNEE_NOT_ACTIVE';
    end if;

    if v_role = 'COMMERCIAL' then
      raise exception 'WORK_ITEM_ASSIGNEE_HAS_NO_WORK_CENTER';
    end if;

    if nullif(btrim(coalesce(new.target_role,'')), '') is null then
      new.target_role := v_role;
    elsif v_role is distinct from new.target_role then
      raise exception 'WORK_ITEM_ASSIGNEE_ROLE_MISMATCH';
    end if;

    return new;
  end if;

  -- Compatibilidade com automacoes antigas: se GT nascer sem pessoa explicita,
  -- usa o GT atual da carteira. Uma reatribuicao nominal posterior nao e' sobrescrita.
  if new.target_role = 'GT' and new.client_id is not null then
    select c.gt_owner into v_gt
    from agency_ops.clients c
    where c.id = new.client_id;

    if nullif(btrim(coalesce(v_gt,'')), '') is not null
       and exists (
         select 1 from agency_ops.team_roster tr
         where tr.person = v_gt and tr.role = 'GT' and tr.is_former = false
       ) then
      new.target_person := v_gt;
    end if;
  end if;

  return new;
end;
$function$;

create or replace function agency_ops.validate_dashboard_work_item_assignee()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $function$
declare
  v_role text;
  v_gt text;
begin
  if coalesce(new.source,'dashboard') <> 'dashboard' then
    return new;
  end if;

  if nullif(btrim(coalesce(new.target_person,'')), '') is null
     and new.target_role = 'GT'
     and new.client_id is not null then
    select c.gt_owner into v_gt
    from agency_ops.clients c
    where c.id = new.client_id;
    if nullif(btrim(coalesce(v_gt,'')), '') is not null then
      new.target_person := v_gt;
    end if;
  end if;

  if nullif(btrim(coalesce(new.target_person,'')), '') is null then
    raise exception 'WORK_ITEM_ASSIGNEE_REQUIRED';
  end if;

  select tr.role into v_role
  from agency_ops.team_roster tr
  where tr.person = new.target_person
    and tr.is_former = false
  limit 1;

  if v_role is null then
    raise exception 'WORK_ITEM_ASSIGNEE_NOT_ACTIVE';
  end if;

  if v_role = 'COMMERCIAL' then
    raise exception 'WORK_ITEM_ASSIGNEE_HAS_NO_WORK_CENTER';
  end if;

  if nullif(btrim(coalesce(new.target_role,'')), '') is null then
    new.target_role := v_role;
  elsif new.target_role is distinct from v_role then
    raise exception 'WORK_ITEM_ASSIGNEE_ROLE_MISMATCH';
  end if;

  return new;
end;
$function$;

create or replace function agency_ops.audit_work_item()
returns trigger
language plpgsql
set search_path to 'agency_ops','public'
as $function$
declare
  v_event_id bigint;
  v_status_event_id bigint;
  v_detail text;
  v_actor_person text;
  v_actor_user_key text;
  v_reason text;
  v_from_label text;
  v_to_label text;
  notification_description text;
begin
  if tg_op = 'INSERT' then
    insert into agency_ops.work_item_events(
      work_item_id,event_type,actor_user_key,actor_person,previous_status,new_status,detail,metadata
    ) values (
      new.id,'CREATED',new.created_by_user_key,new.created_by_person,null,new.status,new.description,
      jsonb_build_object('target_role',new.target_role,'target_person',new.target_person,'type',new.type,'source',new.source)
    ) returning id into v_event_id;

    notification_description := case
      when new.source = 'task_engine_ai' then
        'Demanda identificada automaticamente pela IA no grupo ' ||
        coalesce(nullif(new.metadata->>'source_group_name',''), 'de WhatsApp') ||
        '. Abra a Central de Trabalho para ver a evidencia literal e o contexto lido.'
      else coalesce(new.description,'Abra a Central de Trabalho para ver e assumir.')
    end;

    insert into agency_ops.platform_notifications(
      event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata
    ) values (
      'work-item-created:' || new.id::text,'WORK_ITEM_ASSIGNED',
      case new.priority when 'CRITICAL' then 'CRITICAL' when 'HIGH' then 'ATTENTION' else 'INFO' end,
      'Nova demanda: ' || new.title,notification_description,
      new.client_id,'work_center',new.created_by_person,now(),
      jsonb_build_object(
        'work_item_id',new.id,
        'target_role',new.target_role,
        'target_person',new.target_person,
        'status',new.status,
        'origin',new.source,
        'source_group_name',new.metadata->>'source_group_name'
      )
    ) on conflict (event_key) do nothing;

    return new;
  end if;

  if old.target_person is distinct from new.target_person
     or old.target_role is distinct from new.target_role then
    v_actor_person := coalesce(nullif(new.metadata->>'reassigned_by_person',''), new.created_by_person, 'Sistema');
    v_actor_user_key := nullif(new.metadata->>'reassigned_by_user_key','');
    v_reason := nullif(new.metadata->>'reassignment_reason','');
    v_from_label := coalesce(nullif(old.target_person,''), nullif(old.target_role,''), 'sem responsavel');
    v_to_label := coalesce(nullif(new.target_person,''), nullif(new.target_role,''), 'sem responsavel');
    v_detail := v_actor_person || ' reatribuiu de ' || v_from_label || ' para ' || v_to_label
      || case when v_reason is not null then '. Motivo: ' || v_reason else '.' end;

    insert into agency_ops.work_item_events(
      work_item_id,event_type,actor_user_key,actor_person,previous_status,new_status,detail,metadata
    ) values (
      new.id,'REASSIGNED',v_actor_user_key,v_actor_person,old.status,new.status,v_detail,
      jsonb_build_object(
        'previous_target_role',old.target_role,
        'previous_target_person',old.target_person,
        'target_role',new.target_role,
        'target_person',new.target_person,
        'reason',v_reason,
        'type',new.type,
        'source',new.source
      )
    ) returning id into v_event_id;

    -- O aviso da atribuicao anterior deixa de parecer pendente para a pessoa antiga.
    update agency_ops.platform_notifications pn
       set read_at = coalesce(pn.read_at, now()),
           metadata = coalesce(pn.metadata,'{}'::jsonb) || jsonb_build_object(
             'assignment_superseded',true,
             'superseded_at',now(),
             'superseded_by_event_id',v_event_id,
             'new_target_person',new.target_person
           )
     where pn.type in ('WORK_ITEM_ASSIGNED','WORK_ITEM_REASSIGNED')
       and pn.metadata->>'work_item_id' = new.id::text
       and coalesce(pn.metadata->>'target_person','') = coalesce(old.target_person,'');

    insert into agency_ops.platform_notifications(
      event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata
    ) values (
      'work-item-reassigned:' || new.id::text || ':' || v_event_id::text,
      'WORK_ITEM_REASSIGNED',
      case new.priority when 'CRITICAL' then 'CRITICAL' when 'HIGH' then 'ATTENTION' else 'INFO' end,
      'Demanda reatribuida: ' || new.title,
      v_detail,
      new.client_id,'work_center',v_actor_person,now(),
      jsonb_build_object(
        'work_item_id',new.id,
        'work_item_event_id',v_event_id,
        'private_to_person',true,
        'target_role',new.target_role,
        'target_person',new.target_person,
        'previous_target_role',old.target_role,
        'previous_target_person',old.target_person,
        'reassigned_by',v_actor_person,
        'reason',v_reason,
        'status',new.status,
        'origin',new.source
      )
    ) on conflict (event_key) do nothing;
  end if;

  if old.status is distinct from new.status then
    v_detail := case
      when new.status in ('OPEN','IN_PROGRESS','WAITING','SNOOZED') then coalesce(new.metadata->>'last_action_detail', new.resolution)
      else new.resolution
    end;
    v_actor_person := coalesce(new.completed_by,new.created_by_person);

    insert into agency_ops.work_item_events(
      work_item_id,event_type,actor_user_key,actor_person,previous_status,new_status,detail,metadata
    ) values (
      new.id,'STATUS_CHANGED',new.created_by_user_key,v_actor_person,old.status,new.status,v_detail,
      jsonb_build_object('target_role',new.target_role,'target_person',new.target_person,'type',new.type,'source',new.source)
    ) returning id into v_status_event_id;

    if new.status = 'COMPLETED' then
      insert into agency_ops.platform_notifications(
        event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata
      ) values (
        'work-item-completed:' || new.id::text || ':' || v_status_event_id::text,
        'WORK_ITEM_COMPLETED','SUCCESS',
        'Demanda concluida: ' || new.title,
        coalesce(new.resolution,'A demanda foi marcada como concluida.'),
        new.client_id,'work_center',new.completed_by,now(),
        jsonb_build_object(
          'work_item_id',new.id,
          'work_item_event_id',v_status_event_id,
          'target_person',new.created_by_person,
          'status',new.status
        )
      );
    end if;
  end if;

  return new;
end;
$function$;

create or replace function agency_ops.reassign_work_item(
  p_work_item_id uuid,
  p_new_target_person text,
  p_actor_user_key text,
  p_actor_person text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog','public'
as $function$
declare
  v_item agency_ops.work_items%rowtype;
  v_updated agency_ops.work_items%rowtype;
  v_target_role text;
  v_event_id bigint;
  v_now timestamptz := now();
  v_count integer;
  v_previous_targets jsonb := '[]'::jsonb;
begin
  select * into v_item
  from agency_ops.work_items
  where id = p_work_item_id
  for update;

  if not found then
    raise exception 'WORK_ITEM_NOT_FOUND';
  end if;

  if v_item.status in ('COMPLETED','DISMISSED') then
    raise exception 'WORK_ITEM_ALREADY_CLOSED';
  end if;

  select tr.role into v_target_role
  from agency_ops.team_roster tr
  where tr.person = p_new_target_person
    and tr.is_former = false
  limit 1;

  if v_target_role is null then
    raise exception 'WORK_ITEM_ASSIGNEE_NOT_ACTIVE';
  end if;

  if v_target_role = 'COMMERCIAL' then
    raise exception 'WORK_ITEM_ASSIGNEE_HAS_NO_WORK_CENTER';
  end if;

  if coalesce(v_item.target_person,'') = coalesce(p_new_target_person,'')
     and coalesce(v_item.target_role,'') = coalesce(v_target_role,'') then
    raise exception 'WORK_ITEM_ALREADY_ASSIGNED_TO_TARGET';
  end if;

  v_count := coalesce(nullif(v_item.metadata->>'reassignment_count','')::integer,0) + 1;

  if jsonb_typeof(v_item.metadata->'reassignment_previous_targets') = 'array' then
    v_previous_targets := v_item.metadata->'reassignment_previous_targets';
  end if;
  if nullif(btrim(coalesce(v_item.target_person,'')), '') is not null
     and not (v_previous_targets @> jsonb_build_array(v_item.target_person)) then
    v_previous_targets := v_previous_targets || jsonb_build_array(v_item.target_person);
  end if;

  update agency_ops.work_items
     set target_person = p_new_target_person,
         target_role = v_target_role,
         metadata = coalesce(v_item.metadata,'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
           'reassignment_count',v_count,
           'reassignment_previous_targets',v_previous_targets,
           'reassigned_at',v_now,
           'reassigned_by_user_key',p_actor_user_key,
           'reassigned_by_person',p_actor_person,
           'reassignment_reason',nullif(btrim(coalesce(p_reason,'')),''),
           'previous_target_person',v_item.target_person,
           'previous_target_role',v_item.target_role
         ))
   where id = p_work_item_id
   returning * into v_updated;

  select e.id into v_event_id
  from agency_ops.work_item_events e
  where e.work_item_id = p_work_item_id
    and e.event_type = 'REASSIGNED'
    and e.occurred_at >= v_now - interval '5 seconds'
  order by e.id desc
  limit 1;

  return jsonb_build_object(
    'ok',true,
    'item',to_jsonb(v_updated),
    'event_id',v_event_id,
    'previous_target_person',v_item.target_person,
    'previous_target_role',v_item.target_role,
    'target_person',v_updated.target_person,
    'target_role',v_updated.target_role
  );
end;
$function$;

revoke all on function agency_ops.reassign_work_item(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function agency_ops.reassign_work_item(uuid,text,text,text,text) to service_role;
