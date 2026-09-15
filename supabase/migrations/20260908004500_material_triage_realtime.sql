-- Triagem operacional em tempo real para briefings e materiais de clientes.
-- Usa a Central de Trabalho como fonte unica de verdade e a Central de Notificacoes para aviso imediato.

alter table agency_ops.work_items drop constraint if exists work_items_type_check;
alter table agency_ops.work_items add constraint work_items_type_check
  check (type in ('ESCALATION','CREATIVE_REQUEST','TECHNICAL','CLIENT_FOLLOWUP','CLICKUP','FINANCE','GENERAL','MATERIAL_TRIAGE'));

create index if not exists work_items_material_triage_open_idx
  on agency_ops.work_items (created_at desc)
  where type = 'MATERIAL_TRIAGE' and status in ('OPEN','IN_PROGRESS','SNOOZED');

-- Mantem o historico existente de work_items, mas evita a notificacao generica duplicada
-- para triagens de material. Tambem normaliza HIGH -> ATTENTION no canal de notificacoes.
create or replace function agency_ops.audit_work_item()
returns trigger
language plpgsql
set search_path to 'agency_ops', 'public'
as $$
declare
  event_label text;
begin
  event_label := case when tg_op = 'INSERT' then 'CREATED' else 'STATUS_CHANGED' end;
  insert into agency_ops.work_item_events(work_item_id,event_type,actor_user_key,actor_person,previous_status,new_status,detail,metadata)
  values (
    new.id,event_label,new.created_by_user_key,coalesce(new.completed_by,new.created_by_person),
    case when tg_op = 'UPDATE' then old.status else null end,new.status,
    case when tg_op = 'INSERT' then new.description else new.resolution end,
    jsonb_build_object('target_role',new.target_role,'target_person',new.target_person,'type',new.type)
  );

  if tg_op = 'INSERT' and new.type <> 'MATERIAL_TRIAGE' then
    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
    values (
      'work-item-created:' || new.id::text,'WORK_ITEM_ASSIGNED',
      case new.priority when 'CRITICAL' then 'CRITICAL' when 'HIGH' then 'ATTENTION' else 'INFO' end,
      'Nova demanda: ' || new.title,coalesce(new.description,'Abra a Central de Trabalho para ver e assumir.'),
      new.client_id,'work_center',new.created_by_person,now(),
      jsonb_build_object('work_item_id',new.id,'target_role',new.target_role,'target_person',new.target_person,'status',new.status)
    ) on conflict (event_key) do nothing;
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status and new.status = 'COMPLETED' then
    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
    values (
      'work-item-completed:' || new.id::text,'WORK_ITEM_COMPLETED','SUCCESS',
      'Demanda concluida: ' || new.title,coalesce(new.resolution,'A demanda foi marcada como concluida.'),
      new.client_id,'work_center',new.completed_by,now(),
      jsonb_build_object('work_item_id',new.id,'target_person',new.created_by_person,'status',new.status)
    ) on conflict (event_key) do nothing;
  end if;
  return new;
end;
$$;

create or replace function agency_ops.enqueue_briefing_material_triage()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops', 'public'
as $$
declare
  v_kind text;
  v_name text;
  v_item agency_ops.work_items%rowtype;
begin
  if new.event_type <> 'BRIEFING_SUBMITTED' then return new; end if;
  if new.product_id is not null then
    v_kind := 'PRODUCT_BRIEFING';
    select name into v_name from public.briefing_products where id = new.product_id;
  elsif new.persona_id is not null then
    v_kind := 'PERSONA';
    select name into v_name from public.briefing_personas where id = new.persona_id;
  else
    return new;
  end if;

  insert into agency_ops.work_items(
    client_id,type,status,priority,title,description,source,source_id,created_by_person,target_role,metadata,created_at
  ) values (
    new.client_id,'MATERIAL_TRIAGE','OPEN','HIGH',
    case when v_kind='PRODUCT_BRIEFING' then 'Briefing de produto recebido' else 'Persona recebida' end || coalesce(' · '||nullif(v_name,''),''),
    'Cliente enviou um novo ' || case when v_kind='PRODUCT_BRIEFING' then 'briefing de produto' else 'briefing de persona' end || ' pelo Briefing Hub.',
    'briefing_hub','briefing-event:'||new.id::text,'Cliente','CS',
    jsonb_build_object('triage_kind',v_kind,'origin','Briefing Hub','entity_id',coalesce(new.product_id,new.persona_id),'entity_name',v_name,'briefing_event_id',new.id,'item_count',1,'received_at',new.occurred_at),
    new.occurred_at
  )
  on conflict (source,source_id) where source_id is not null do update set updated_at=excluded.updated_at
  returning * into v_item;

  insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
  values (
    'material-triage:'||v_item.id::text,'MATERIAL_TRIAGE_NEW','SPECIAL','MATERIAL NOVO — ACAO NECESSARIA',v_item.title,
    v_item.client_id,'material_triage','Cliente',new.occurred_at,
    jsonb_build_object('work_item_id',v_item.id,'target_role','CS','adler_only_or_cs',true,'triage_kind',v_kind,'origin','Briefing Hub')
  ) on conflict (event_key) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_briefing_material_triage on public.briefing_events;
create trigger trg_briefing_material_triage
  after insert on public.briefing_events
  for each row execute function agency_ops.enqueue_briefing_material_triage();

create or replace function agency_ops.enqueue_raw_material_triage()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops', 'public'
as $$
declare
  v_item agency_ops.work_items%rowtype;
  v_photo int := case when new.file_kind='IMAGE' then 1 else 0 end;
  v_video int := case when new.file_kind='VIDEO' then 1 else 0 end;
  v_doc int := case when new.file_kind='DOCUMENT' then 1 else 0 end;
  v_other int := case when coalesce(new.file_kind,'OTHER') not in ('IMAGE','VIDEO','DOCUMENT') then 1 else 0 end;
  v_count int;
  v_title text;
begin
  if new.client_id is null then return new; end if;

  select * into v_item from agency_ops.work_items
   where type='MATERIAL_TRIAGE' and client_id=new.client_id and source='raw_material_upload'
     and status in ('OPEN','IN_PROGRESS','SNOOZED') and created_at >= now() - interval '5 minutes'
   order by created_at desc limit 1 for update;

  if found then
    v_count := coalesce((v_item.metadata->>'item_count')::int,0)+1;
    update agency_ops.work_items set
      title = v_count::text || ' novos materiais recebidos',
      description = 'Cliente enviou um lote com ' || v_count::text || ' arquivos. Aguardando triagem operacional.',
      metadata = metadata || jsonb_build_object(
        'item_count',v_count,
        'photo_count',coalesce((metadata->>'photo_count')::int,0)+v_photo,
        'video_count',coalesce((metadata->>'video_count')::int,0)+v_video,
        'document_count',coalesce((metadata->>'document_count')::int,0)+v_doc,
        'other_count',coalesce((metadata->>'other_count')::int,0)+v_other,
        'last_received_at',coalesce(new.drive_uploaded_at,new.detected_at,now()),
        'latest_file_name',new.file_name
      ), updated_at=now()
    where id=v_item.id returning * into v_item;
  else
    v_count := 1;
    insert into agency_ops.work_items(
      client_id,type,status,priority,title,description,source,source_id,created_by_person,target_role,metadata,created_at
    ) values (
      new.client_id,'MATERIAL_TRIAGE','OPEN','MEDIUM','1 novo material recebido','Cliente enviou novo material. Aguardando triagem operacional.',
      'raw_material_upload','raw-material-batch:'||new.id::text,'Cliente','CS',
      jsonb_build_object('triage_kind','ASSET_BATCH','origin','Materiais / Drive','item_count',1,'photo_count',v_photo,'video_count',v_video,'document_count',v_doc,'other_count',v_other,'first_file_id',new.id,'latest_file_name',new.file_name,'received_at',coalesce(new.drive_uploaded_at,new.detected_at,now()),'last_received_at',coalesce(new.drive_uploaded_at,new.detected_at,now())),
      coalesce(new.drive_uploaded_at,new.detected_at,now())
    ) returning * into v_item;
  end if;

  v_title := case when v_count=1 then '1 novo material recebido' else v_count::text||' novos materiais recebidos' end;
  insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
  values ('material-triage:'||v_item.id::text,'MATERIAL_TRIAGE_NEW','ATTENTION','MATERIAL NOVO — ACAO NECESSARIA',v_title,v_item.client_id,'material_triage','Cliente',now(),jsonb_build_object('work_item_id',v_item.id,'target_role','CS','adler_only_or_cs',true,'triage_kind','ASSET_BATCH','origin','Materiais / Drive','item_count',v_count))
  on conflict (event_key) do update set description=excluded.description, occurred_at=excluded.occurred_at, metadata=agency_ops.platform_notifications.metadata||excluded.metadata;
  return new;
end;
$$;

drop trigger if exists trg_raw_material_triage on agency_ops.client_raw_material_uploads;
create trigger trg_raw_material_triage
  after insert on agency_ops.client_raw_material_uploads
  for each row execute function agency_ops.enqueue_raw_material_triage();

create or replace function agency_ops.escalate_material_triage()
returns integer
language plpgsql
security definer
set search_path to 'agency_ops', 'public'
as $$
declare v_count integer;
begin
  insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)
  select 'material-triage-escalated:'||w.id::text,'MATERIAL_TRIAGE_ESCALATED','CRITICAL','TRIAGEM PARADA HA 30 MINUTOS','Material novo continua sem responsavel. Acao imediata do Adler.',w.client_id,'material_triage','Sistema',now(),jsonb_build_object('work_item_id',w.id,'target_person','Adler Furtado','adler_only',true,'triage_kind',w.metadata->>'triage_kind')
  from agency_ops.work_items w
  where w.type='MATERIAL_TRIAGE' and w.status='OPEN' and w.created_at <= now()-interval '30 minutes'
  on conflict (event_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Agenda a escalada apenas se pg_cron estiver instalado (ja e usado pela operacao atual).
do $$
begin
  if exists (select 1 from pg_extension where extname='pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname='material-triage-escalation';
    perform cron.schedule('material-triage-escalation','*/5 * * * *','select agency_ops.escalate_material_triage();');
  end if;
exception when others then
  raise notice 'material triage cron not scheduled: %', sqlerrm;
end $$;

