-- Closer briefing V3: one queue path, hard Task Engine exclusion, and current-client audit.

drop trigger if exists clients_enqueue_closer_briefing on agency_ops.clients;

create or replace function agency_ops.enqueue_closer_briefing_for_client(
  p_client_id uuid,
  p_source text default 'CLIENT_LIFECYCLE',
  p_won_event_id uuid default null
) returns void
language plpgsql
security definer
set search_path = agency_ops, public, pg_temp
as $$
declare
  v_lifecycle text;
  v_existing_page text;
begin
  select lifecycle into v_lifecycle from agency_ops.clients where id = p_client_id;
  if v_lifecycle not in ('ONBOARDING','ACTIVE') then return; end if;

  select notion_page_id into v_existing_page
  from agency_ops.notion_briefing_pages
  where client_id = p_client_id and sync_status <> 'ERROR'
  order by updated_at desc
  limit 1;

  insert into agency_ops.closer_briefing_jobs(
    client_id, won_event_id, source, status, available_at, last_error, metadata, updated_at
  ) values (
    p_client_id, p_won_event_id, coalesce(p_source,'CLIENT_LIFECYCLE'), 'PENDING', now(), null,
    jsonb_strip_nulls(jsonb_build_object(
      'existing_briefing_page_id', v_existing_page,
      'queued_reason', coalesce(p_source,'CLIENT_LIFECYCLE'),
      'queued_at', now()
    )), now()
  )
  on conflict(client_id) do update set
    won_event_id = coalesce(excluded.won_event_id, agency_ops.closer_briefing_jobs.won_event_id),
    source = excluded.source,
    status = case when agency_ops.closer_briefing_jobs.status = 'RUNNING' then agency_ops.closer_briefing_jobs.status else 'PENDING' end,
    available_at = case when agency_ops.closer_briefing_jobs.status = 'RUNNING' then agency_ops.closer_briefing_jobs.available_at else now() end,
    last_error = case when agency_ops.closer_briefing_jobs.status = 'RUNNING' then agency_ops.closer_briefing_jobs.last_error else null end,
    metadata = coalesce(agency_ops.closer_briefing_jobs.metadata,'{}'::jsonb) || excluded.metadata,
    updated_at = now();
end;
$$;

create or replace function agency_ops.guard_excluded_transcript_task_event()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public, pg_temp
as $$
begin
  if new.source = 'TRANSCRIPT' and new.message_id is not null and exists (
    select 1
    from agency_ops.meeting_transcripts mt
    where mt.meeting_key = new.message_id
      and coalesce((mt.metadata->>'task_engine_eligible')::boolean, true) = false
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_excluded_transcript_task_event on agency_ops.task_generation_events;
create trigger trg_guard_excluded_transcript_task_event
before insert on agency_ops.task_generation_events
for each row execute function agency_ops.guard_excluded_transcript_task_event();

insert into agency_ops.donnah_mcp_accounts(person, secret_name, enabled, mcp_endpoint)
values ('Vitor Feitoza','DONNAH_MCP_VITOR_FEITOZA',true,'https://mcp.donnah.ai/mcp')
on conflict(person) do update set
  secret_name = excluded.secret_name,
  enabled = true,
  mcp_endpoint = excluded.mcp_endpoint,
  updated_at = now();

update agency_ops.meeting_transcripts
set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
      'closer_source', true,
      'commercial_source', true,
      'task_engine_eligible', false,
      'task_engine_policy', 'CLOSER_EXCLUDED',
      'closer_person', 'Vitor Feitoza'
    ),
    updated_at = now()
where metadata->>'mcp_owner_person' = 'Vitor Feitoza';

update agency_ops.task_generation_events e
set status='DONE', processed_at=coalesce(processed_at,now()), last_error='blocked: closer transcript'
where e.source='TRANSCRIPT'
  and e.status in ('PENDING','ERROR','PROCESSING')
  and exists (
    select 1 from agency_ops.meeting_transcripts mt
    where mt.meeting_key=e.message_id
      and mt.metadata->>'mcp_owner_person'='Vitor Feitoza'
  );

insert into agency_ops.closer_briefing_jobs(client_id, source, status, available_at, attempt_count, metadata, created_at, updated_at)
select c.id, 'CURRENT_CLIENT_AUDIT', 'PENDING', now(), 0,
       jsonb_build_object('audit_seeded_at',now(),'lifecycle',c.lifecycle), now(), now()
from agency_ops.clients c
where c.lifecycle in ('ONBOARDING','ACTIVE')
  and not exists (
    select 1 from agency_ops.notion_briefing_pages nb
    where nb.client_id=c.id and nb.sync_status<>'ERROR'
  )
on conflict(client_id) do update set
  source='CURRENT_CLIENT_AUDIT',
  status=case when agency_ops.closer_briefing_jobs.status='RUNNING' then 'RUNNING' else 'PENDING' end,
  available_at=case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.available_at else now() end,
  attempt_count=case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.attempt_count else 0 end,
  last_error=case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.last_error else null end,
  metadata=coalesce(agency_ops.closer_briefing_jobs.metadata,'{}'::jsonb) || jsonb_build_object('audit_seeded_at',now()),
  updated_at=now();