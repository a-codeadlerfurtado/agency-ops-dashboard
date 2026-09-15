create table if not exists agency_ops.closer_briefing_invocation_guard (
  singleton boolean primary key default true check (singleton),
  last_invoked_at timestamptz,
  last_request_id bigint,
  updated_at timestamptz not null default now()
);

insert into agency_ops.closer_briefing_invocation_guard(singleton)
values (true)
on conflict (singleton) do nothing;

alter table agency_ops.closer_briefing_invocation_guard enable row level security;
revoke all on agency_ops.closer_briefing_invocation_guard from anon, authenticated;
grant all on agency_ops.closer_briefing_invocation_guard to service_role;

create or replace function agency_ops.invoke_closer_briefing_sync(p_limit integer default 5)
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog','agency_ops','net'
as $$
declare
  v_request_id bigint;
  v_acquired boolean := false;
begin
  update agency_ops.closer_briefing_invocation_guard
     set last_invoked_at = now(),
         updated_at = now()
   where singleton = true
     and (last_invoked_at is null or last_invoked_at <= now() - interval '5 minutes')
  returning true into v_acquired;

  if not coalesce(v_acquired,false) then
    return null;
  end if;

  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-closer-briefing-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-closer-briefing-secret',agency_ops.get_secret('CLOSER_BRIEFING_SYNC_SECRET')
    ),
    body := jsonb_build_object('limit',greatest(1,least(coalesce(p_limit,5),8))),
    timeout_milliseconds := 15000
  ) into v_request_id;

  update agency_ops.closer_briefing_invocation_guard
     set last_request_id = v_request_id,
         updated_at = now()
   where singleton = true;

  return v_request_id;
exception when others then
  update agency_ops.closer_briefing_invocation_guard
     set last_invoked_at = null,
         updated_at = now()
   where singleton = true;
  raise;
end;
$$;

create or replace function agency_ops.enqueue_closer_briefing_for_client(
  p_client_id uuid,
  p_source text default 'CLIENT_LIFECYCLE',
  p_won_event_id uuid default null
)
returns void
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_temp'
as $$
declare
  v_lifecycle text;
  v_existing record;
  v_source text := coalesce(p_source,'CLIENT_LIFECYCLE');
begin
  select lifecycle into v_lifecycle
    from agency_ops.clients
   where id = p_client_id;

  if v_lifecycle not in ('ONBOARDING','ACTIVE') then
    return;
  end if;

  select notion_page_id, page_url, title
    into v_existing
    from agency_ops.notion_briefing_pages
   where client_id = p_client_id
     and match_status = 'CONFIRMED'
     and sync_status not in ('ERROR','ARCHIVED')
   order by updated_at desc
   limit 1;

  if v_existing.notion_page_id is not null and v_source <> 'CLOSER_TRANSCRIPT' then
    insert into agency_ops.closer_briefing_jobs(
      client_id, won_event_id, source, status, available_at,
      processed_at, notion_page_id, notion_page_url, briefing_title,
      last_error, metadata, updated_at
    ) values (
      p_client_id,
      p_won_event_id,
      v_source,
      'DONE',
      now(),
      now(),
      v_existing.notion_page_id,
      v_existing.page_url,
      v_existing.title,
      null,
      jsonb_build_object(
        'briefing_mode','USE_EXISTING',
        'existing_briefing_page_id',v_existing.notion_page_id,
        'queued_reason',v_source,
        'dedupe_guard','existing_confirmed_page',
        'queued_at',now()
      ),
      now()
    )
    on conflict(client_id) do update set
      won_event_id = coalesce(excluded.won_event_id, agency_ops.closer_briefing_jobs.won_event_id),
      source = excluded.source,
      status = case when agency_ops.closer_briefing_jobs.status='RUNNING' then 'RUNNING' else 'DONE' end,
      available_at = case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.available_at else excluded.available_at end,
      processed_at = case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.processed_at else now() end,
      notion_page_id = case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.notion_page_id else excluded.notion_page_id end,
      notion_page_url = case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.notion_page_url else excluded.notion_page_url end,
      briefing_title = case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.briefing_title else excluded.briefing_title end,
      last_error = case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.last_error else null end,
      metadata = coalesce(agency_ops.closer_briefing_jobs.metadata,'{}'::jsonb) || excluded.metadata,
      updated_at = now();
    return;
  end if;

  insert into agency_ops.closer_briefing_jobs(
    client_id, won_event_id, source, status, available_at,
    notion_page_id, notion_page_url, briefing_title,
    last_error, metadata, updated_at
  ) values (
    p_client_id,
    p_won_event_id,
    v_source,
    'PENDING',
    now(),
    v_existing.notion_page_id,
    v_existing.page_url,
    v_existing.title,
    null,
    jsonb_strip_nulls(jsonb_build_object(
      'briefing_mode',case when v_existing.notion_page_id is null then 'CREATE_ALLOWED' else 'ENRICH_EXISTING' end,
      'existing_briefing_page_id',v_existing.notion_page_id,
      'queued_reason',v_source,
      'queued_at',now()
    )),
    now()
  )
  on conflict(client_id) do update set
    won_event_id = coalesce(excluded.won_event_id, agency_ops.closer_briefing_jobs.won_event_id),
    source = excluded.source,
    status = case when agency_ops.closer_briefing_jobs.status='RUNNING' then 'RUNNING' else 'PENDING' end,
    available_at = case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.available_at else now() end,
    notion_page_id = coalesce(excluded.notion_page_id, agency_ops.closer_briefing_jobs.notion_page_id),
    notion_page_url = coalesce(excluded.notion_page_url, agency_ops.closer_briefing_jobs.notion_page_url),
    briefing_title = coalesce(excluded.briefing_title, agency_ops.closer_briefing_jobs.briefing_title),
    last_error = case when agency_ops.closer_briefing_jobs.status='RUNNING' then agency_ops.closer_briefing_jobs.last_error else null end,
    metadata = coalesce(agency_ops.closer_briefing_jobs.metadata,'{}'::jsonb) || excluded.metadata,
    updated_at = now();
end;
$$;

create or replace function agency_ops.guard_second_confirmed_briefing_link()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_temp'
as $$
begin
  if new.client_id is null
     or new.match_status <> 'CONFIRMED'
     or new.sync_status in ('ERROR','ARCHIVED') then
    return new;
  end if;

  if tg_op='UPDATE'
     and old.client_id is not distinct from new.client_id
     and old.match_status is not distinct from new.match_status then
    return new;
  end if;

  if exists (
    select 1
      from agency_ops.notion_briefing_pages p
     where p.client_id = new.client_id
       and p.notion_page_id <> new.notion_page_id
       and p.match_status = 'CONFIRMED'
       and p.sync_status not in ('ERROR','ARCHIVED')
  ) then
    raise exception 'confirmed briefing already linked for client %', new.client_id
      using errcode='23505';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_second_confirmed_briefing_link on agency_ops.notion_briefing_pages;
create trigger trg_guard_second_confirmed_briefing_link
before insert or update of client_id, match_status, sync_status
on agency_ops.notion_briefing_pages
for each row
execute function agency_ops.guard_second_confirmed_briefing_link();
