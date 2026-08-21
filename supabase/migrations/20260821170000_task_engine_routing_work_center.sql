-- Task Engine: roteia execucao tecnica para ClickUp e comunicacao/follow-up para a Central de Trabalho.
-- Tambem registra o destino na auditoria e garante idempotencia dos work items criados pela IA.

alter table agency_ops.generated_tasks
  add column if not exists destination text,
  add column if not exists central_type text,
  add column if not exists work_item_id uuid references agency_ops.work_items(id) on delete set null;

alter table agency_ops.generated_tasks
  drop constraint if exists generated_tasks_status_check;

alter table agency_ops.generated_tasks
  add constraint generated_tasks_status_check
  check (status = any (array['PROPOSTA'::text,'DUPLICADA'::text,'ENVIADA'::text,'CENTRAL'::text,'DESCARTADA'::text,'ERRO'::text]));

alter table agency_ops.generated_tasks
  drop constraint if exists generated_tasks_destination_check;

alter table agency_ops.generated_tasks
  add constraint generated_tasks_destination_check
  check (destination is null or destination = any (array['CLICKUP'::text,'CENTRAL'::text,'IGNORE'::text]));

create index if not exists generated_tasks_destination_idx
  on agency_ops.generated_tasks (destination, status, created_at desc);

create index if not exists generated_tasks_work_item_idx
  on agency_ops.generated_tasks (work_item_id)
  where work_item_id is not null;

create unique index if not exists work_items_source_source_id_uidx
  on agency_ops.work_items (source, source_id)
  where source_id is not null;
