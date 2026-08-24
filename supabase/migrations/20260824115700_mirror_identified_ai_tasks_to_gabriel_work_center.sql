-- Central de Trabalho do Gabriel: recebe somente demandas tecnicas da nossa IA
-- identificadas automaticamente pelo Task Engine para clientes com N8N nosso.
-- A task continua sendo executada no ClickUp; work_items guarda o espelho operacional.

create unique index if not exists work_items_ai_clickup_mirror_source_uidx
  on agency_ops.work_items(source, source_id)
  where source = 'ai_clickup_mirror' and source_id is not null;

create or replace function agency_ops.is_identified_our_ai_clickup_task(
  p_client_id uuid,
  p_name text,
  p_description text
)
returns boolean
language sql
stable
security definer
set search_path = agency_ops, public
as $$
  select
    p_client_id is not null
    and exists (
      select 1 from agency_ops.ai_ours_active_client_ids() a
      where a.client_id = p_client_id
    )
    and coalesce(p_description, '') ilike '%Task identificada automaticamente pela IA%'
    and coalesce(p_description, '') ilike '%Task Engine%'
    and lower(coalesce(p_name, '')) ~ '( - automação - | - automacao - |n8n|agente|chatbot|bot de atendimento|webhook|prompt|llm|openai|assistente virtual|fluxo de atendimento| - ia - )';
$$;
revoke all on function agency_ops.is_identified_our_ai_clickup_task(uuid,text,text) from public;
grant execute on function agency_ops.is_identified_our_ai_clickup_task(uuid,text,text) to service_role;

create or replace function agency_ops.sync_identified_ai_clickup_to_gabriel_work()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
declare
  v_matches boolean;
  v_status text;
  v_source_id text;
  v_resolution text;
begin
  v_source_id := 'clickup:' || new.task_id;
  v_matches := agency_ops.is_identified_our_ai_clickup_task(new.client_id, new.name, new.description);

  if not v_matches then
    update agency_ops.work_items
       set status = 'DISMISSED',
           resolution = 'Saiu do escopo automático da IA da agência.',
           completed_at = coalesce(completed_at, now()),
           completed_by = coalesce(completed_by, 'Sistema · IA'),
           updated_at = now(),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('ai_scope_current', false)
     where source = 'ai_clickup_mirror'
       and source_id = v_source_id
       and status not in ('COMPLETED','DISMISSED');
    return new;
  end if;

  if new.is_closed then
    v_status := 'COMPLETED';
    v_resolution := 'Concluída no ClickUp.';
  elsif lower(coalesce(new.status,'')) ~ '(progress|andamento|fazendo|doing|produc)' then
    v_status := 'IN_PROGRESS';
    v_resolution := null;
  elsif lower(coalesce(new.status,'')) ~ '(wait|aguard|bloque|pendencia externa)' then
    v_status := 'WAITING';
    v_resolution := null;
  else
    v_status := 'OPEN';
    v_resolution := null;
  end if;

  insert into agency_ops.work_items (
    client_id, type, status, priority, title, description, source, source_id,
    created_by_user_key, created_by_person, target_role, target_person, due_at,
    completed_at, completed_by, resolution, metadata, created_at, updated_at
  ) values (
    new.client_id, 'TECHNICAL', v_status, 'MEDIUM',
    left(coalesce(new.name, 'Demanda técnica de IA'), 240),
    left('Demanda identificada automaticamente pelo Task Engine para alteração/manutenção da IA da agência. Execução vinculada ao ClickUp.' || E'\n\n' || coalesce(new.description,''), 6000),
    'ai_clickup_mirror', v_source_id,
    'system:task-engine-ai-mirror', 'IA · Task Engine',
    'AI', 'Gabriel Castro', new.due_date,
    case when v_status = 'COMPLETED' then coalesce(new.date_closed, now()) else null end,
    case when v_status = 'COMPLETED' then 'ClickUp' else null end,
    v_resolution,
    jsonb_build_object(
      'ai_workspace', true,
      'n8n_verified', true,
      'ai_classified', true,
      'task_engine_identified', true,
      'imported_from_clickup', true,
      'ai_scope_current', true,
      'scope_model', 'AI_N8N_CLIENTS_AI_DEMANDS_ONLY',
      'clickup_task_id', new.task_id,
      'clickup_url', new.url,
      'clickup_list_name', new.list_name,
      'clickup_status', new.status
    ),
    coalesce(new.date_created, now()), now()
  )
  on conflict (source, source_id) where source = 'ai_clickup_mirror' and source_id is not null
  do update set
    client_id = excluded.client_id,
    type = excluded.type,
    status = excluded.status,
    title = excluded.title,
    description = excluded.description,
    target_role = 'AI',
    target_person = 'Gabriel Castro',
    due_at = excluded.due_at,
    completed_at = excluded.completed_at,
    completed_by = excluded.completed_by,
    resolution = excluded.resolution,
    metadata = coalesce(agency_ops.work_items.metadata, '{}'::jsonb) || excluded.metadata,
    updated_at = now();
  return new;
end;
$$;
revoke all on function agency_ops.sync_identified_ai_clickup_to_gabriel_work() from public;

drop trigger if exists trg_sync_identified_ai_clickup_to_gabriel_work on agency_ops.clickup_tasks;
create trigger trg_sync_identified_ai_clickup_to_gabriel_work
after insert or update of client_id, name, description, status, is_closed, due_date, date_closed, url, list_name
on agency_ops.clickup_tasks
for each row execute function agency_ops.sync_identified_ai_clickup_to_gabriel_work();

insert into agency_ops.work_items (
  client_id, type, status, priority, title, description, source, source_id,
  created_by_user_key, created_by_person, target_role, target_person, due_at,
  completed_at, completed_by, resolution, metadata, created_at, updated_at
)
select
  t.client_id, 'TECHNICAL',
  case
    when t.is_closed then 'COMPLETED'
    when lower(coalesce(t.status,'')) ~ '(progress|andamento|fazendo|doing|produc)' then 'IN_PROGRESS'
    when lower(coalesce(t.status,'')) ~ '(wait|aguard|bloque|pendencia externa)' then 'WAITING'
    else 'OPEN'
  end,
  'MEDIUM', left(coalesce(t.name,'Demanda técnica de IA'),240),
  left('Demanda identificada automaticamente pelo Task Engine para alteração/manutenção da IA da agência. Execução vinculada ao ClickUp.' || E'\n\n' || coalesce(t.description,''),6000),
  'ai_clickup_mirror', 'clickup:' || t.task_id,
  'system:task-engine-ai-mirror', 'IA · Task Engine', 'AI', 'Gabriel Castro', t.due_date,
  case when t.is_closed then coalesce(t.date_closed,now()) else null end,
  case when t.is_closed then 'ClickUp' else null end,
  case when t.is_closed then 'Concluída no ClickUp.' else null end,
  jsonb_build_object('ai_workspace',true,'n8n_verified',true,'ai_classified',true,'task_engine_identified',true,'imported_from_clickup',true,'ai_scope_current',true,'scope_model','AI_N8N_CLIENTS_AI_DEMANDS_ONLY','clickup_task_id',t.task_id,'clickup_url',t.url,'clickup_list_name',t.list_name,'clickup_status',t.status),
  coalesce(t.date_created,now()), now()
from agency_ops.clickup_tasks t
where agency_ops.is_identified_our_ai_clickup_task(t.client_id,t.name,t.description)
on conflict (source, source_id) where source = 'ai_clickup_mirror' and source_id is not null
do update set
  status=excluded.status,
  title=excluded.title,
  description=excluded.description,
  target_role='AI',
  target_person='Gabriel Castro',
  due_at=excluded.due_at,
  completed_at=excluded.completed_at,
  completed_by=excluded.completed_by,
  resolution=excluded.resolution,
  metadata=coalesce(agency_ops.work_items.metadata,'{}'::jsonb)||excluded.metadata,
  updated_at=now();
