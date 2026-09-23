-- Radar de Anuncios: durable data model and queue.
-- New objects only; existing creative intelligence and briefing flows stay untouched.

create table if not exists agency_ops.ad_radar_runtime_config (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  auto_briefing_enabled boolean not null default true,
  external_collection_enabled boolean not null default false,
  provider text not null default 'FOREPLAY',
  max_runs_per_tick integer not null default 2 check (max_runs_per_tick between 1 and 10),
  max_queries_per_run integer not null default 4 check (max_queries_per_run between 1 and 12),
  max_ads_per_query integer not null default 25 check (max_ads_per_query between 1 and 250),
  refresh_days integer not null default 14 check (refresh_days between 1 and 90),
  updated_at timestamptz not null default now()
);
insert into agency_ops.ad_radar_runtime_config(id) values (1) on conflict (id) do nothing;

create table if not exists agency_ops.ad_radar_product_entities (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  aliases text[] not null default '{}',
  city text,
  neighborhood text,
  address text,
  builder text,
  developer text,
  phase text,
  tower text,
  typology text,
  official_site_url text,
  official_assets jsonb not null default '{}'::jsonb,
  approved_public_facts jsonb not null default '{}'::jsonb,
  merged_into_id uuid references agency_ops.ad_radar_product_entities(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists agency_ops.ad_radar_product_contexts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  briefing_product_id uuid not null references public.briefing_products(id) on delete cascade,
  product_entity_id uuid not null references agency_ops.ad_radar_product_entities(id),
  briefing_template_id uuid,
  briefing_completed_at timestamptz,
  briefing_updated_at timestamptz,
  commercial_context jsonb not null default '{}'::jsonb,
  context_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (briefing_product_id)
);
create index if not exists ad_radar_context_client_idx on agency_ops.ad_radar_product_contexts(client_id, updated_at desc);

create table if not exists agency_ops.ad_radar_runs (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references agency_ops.ad_radar_product_contexts(id) on delete cascade,
  trigger_type text not null,
  trigger_event_id uuid,
  idempotency_key text not null unique,
  provider text not null default 'FOREPLAY',
  status text not null default 'WAITING' check (status in (
    'WAITING','SEARCHING','PARTIAL','ANALYZING','AVAILABLE','NO_RESULTS','FAILED_RECOVERABLE','ACTION_REQUIRED'
  )),
  run_version text not null,
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  locked_at timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 4,
  is_partial boolean not null default false,
  query_count integer not null default 0,
  ads_found integer not null default 0,
  distinct_creatives integer not null default 0,
  media_available integer not null default 0,
  media_analyzed integer not null default 0,
  provider_credit_cost numeric,
  provider_credits_remaining numeric,
  elapsed_ms integer,
  error_code text,
  error_detail text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ad_radar_runs_queue_idx on agency_ops.ad_radar_runs(status, available_at, requested_at);
create index if not exists ad_radar_runs_context_idx on agency_ops.ad_radar_runs(context_id, requested_at desc);

create table if not exists agency_ops.ad_radar_queries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agency_ops.ad_radar_runs(id) on delete cascade,
  provider text not null,
  query_kind text not null,
  query_text text,
  advertiser_external_id text,
  cursor_in text,
  cursor_out text,
  status text not null default 'WAITING',
  result_count integer not null default 0,
  credit_cost numeric,
  elapsed_ms integer,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists agency_ops.ad_radar_advertisers (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  name text,
  page_url text,
  metadata jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique(provider, external_id)
);

create table if not exists agency_ops.ad_radar_ads (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_ad_id text not null,
  advertiser_id uuid references agency_ops.ad_radar_advertisers(id),
  source_url text,
  provider_url text,
  destination_url text,
  ad_name text,
  primary_text text,
  headline text,
  description text,
  cta text,
  display_format text,
  platforms text[] not null default '{}',
  live_state text,
  started_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  raw_metadata jsonb not null default '{}'::jsonb,
  unique(provider, external_ad_id)
);
create index if not exists ad_radar_ads_advertiser_idx on agency_ops.ad_radar_ads(advertiser_id, last_seen_at desc);

create table if not exists agency_ops.ad_radar_media (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null references agency_ops.ad_radar_ads(id) on delete cascade,
  media_key text not null,
  position integer not null default 0,
  media_type text not null check (media_type in ('IMAGE','VIDEO','THUMBNAIL','PDF','OTHER')),
  provider_url text,
  storage_bucket text,
  storage_path text,
  width integer,
  height integer,
  duration_seconds numeric,
  sha256 text,
  perceptual_hash text,
  availability text not null default 'UNKNOWN',
  captured_at timestamptz not null default now(),
  last_verified_at timestamptz,
  unique(ad_id, media_key)
);
create index if not exists ad_radar_media_ad_idx on agency_ops.ad_radar_media(ad_id, position);

create table if not exists agency_ops.ad_radar_matches (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agency_ops.ad_radar_runs(id) on delete cascade,
  context_id uuid not null references agency_ops.ad_radar_product_contexts(id) on delete cascade,
  ad_id uuid not null references agency_ops.ad_radar_ads(id) on delete cascade,
  category text not null check (category in (
    'CONFIRMED','POSSIBLE','REGIONAL_COMPETITOR','EXECUTION_REFERENCE','OURS','REJECTED'
  )),
  evidence jsonb not null default '[]'::jsonb,
  confidence_label text,
  decision_source text not null default 'AUTO' check (decision_source in ('AUTO','HUMAN')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique(run_id, ad_id)
);
create index if not exists ad_radar_matches_context_idx on agency_ops.ad_radar_matches(context_id, category, created_at desc);

create table if not exists agency_ops.ad_radar_match_overrides (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references agency_ops.ad_radar_product_contexts(id) on delete cascade,
  ad_id uuid not null references agency_ops.ad_radar_ads(id) on delete cascade,
  category text not null check (category in (
    'CONFIRMED','POSSIBLE','REGIONAL_COMPETITOR','EXECUTION_REFERENCE','OURS','REJECTED'
  )),
  note text,
  actor text not null,
  updated_at timestamptz not null default now(),
  unique(context_id, ad_id)
);

create table if not exists agency_ops.ad_radar_observations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agency_ops.ad_radar_runs(id) on delete cascade,
  ad_id uuid not null references agency_ops.ad_radar_ads(id) on delete cascade,
  observed_at timestamptz not null default now(),
  provider_live_state text,
  present_in_collection boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  unique(run_id, ad_id)
);

create table if not exists agency_ops.ad_radar_analyses (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid references agency_ops.ad_radar_ads(id) on delete cascade,
  media_id uuid references agency_ops.ad_radar_media(id) on delete cascade,
  analysis_type text not null,
  model_name text,
  prompt_version text,
  source_scope text not null,
  status text not null default 'PENDING',
  output jsonb not null default '{}'::jsonb,
  limitations text,
  reuse_key text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists ad_radar_analysis_reuse_idx on agency_ops.ad_radar_analyses(reuse_key) where reuse_key is not null;

create table if not exists agency_ops.ad_radar_saved_references (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references agency_ops.ad_radar_product_contexts(id) on delete cascade,
  ad_id uuid not null references agency_ops.ad_radar_ads(id) on delete cascade,
  title text,
  notes text,
  saved_by text not null,
  created_at timestamptz not null default now(),
  unique(context_id, ad_id)
);

create table if not exists agency_ops.ad_radar_feedback (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references agency_ops.ad_radar_product_contexts(id) on delete cascade,
  run_id uuid references agency_ops.ad_radar_runs(id) on delete set null,
  ad_id uuid references agency_ops.ad_radar_ads(id) on delete set null,
  feedback_type text not null,
  detail text,
  actor text not null,
  created_at timestamptz not null default now()
);

create table if not exists agency_ops.ad_radar_directions (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references agency_ops.ad_radar_product_contexts(id) on delete cascade,
  version integer not null default 1,
  status text not null default 'DRAFT',
  audience text,
  objective text,
  argument text,
  suggested_call text,
  composition jsonb not null default '{}'::jsonb,
  source_materials jsonb not null default '[]'::jsonb,
  reference_ids uuid[] not null default '{}',
  hypothesis text,
  confirmation_needed text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(context_id, version)
);

create table if not exists agency_ops.ad_radar_links (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references agency_ops.ad_radar_product_contexts(id) on delete cascade,
  direction_id uuid references agency_ops.ad_radar_directions(id) on delete set null,
  work_item_id uuid references agency_ops.work_items(id) on delete set null,
  creative_catalog_id uuid,
  meta_ad_id text,
  link_type text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists agency_ops.ad_radar_pilot_cases (
  id uuid primary key default gen_random_uuid(),
  briefing_product_id uuid not null references public.briefing_products(id) on delete cascade,
  selection_reason text not null,
  state text not null default 'PENDING',
  manual_sample_count integer,
  automatic_sample_count integer,
  confirmed_matches integer,
  false_matches integer,
  duplicate_count integer,
  media_available integer,
  elapsed_ms integer,
  observed_cost numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(briefing_product_id)
);

create or replace function agency_ops.ad_radar_context_for_product(p_product_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
declare
  p public.briefing_products%rowtype;
  v_entity uuid;
  v_context uuid;
  v_version text;
begin
  select * into p from public.briefing_products where id = p_product_id and archived_at is null;
  if not found then raise exception 'radar_product_not_found'; end if;
  v_version := coalesce(p.completed_at, p.updated_at, p.created_at)::text;

  select id into v_context from agency_ops.ad_radar_product_contexts where briefing_product_id = p.id;
  if v_context is not null then
    update agency_ops.ad_radar_product_contexts
       set briefing_template_id=p.template_id, briefing_completed_at=p.completed_at,
           briefing_updated_at=p.updated_at, context_version=v_version, updated_at=now()
     where id=v_context;
    return v_context;
  end if;

  insert into agency_ops.ad_radar_product_entities(canonical_name)
  values (coalesce(nullif(btrim(p.name),''),'Produto sem nome'))
  returning id into v_entity;

  insert into agency_ops.ad_radar_product_contexts(
    client_id,briefing_product_id,product_entity_id,briefing_template_id,
    briefing_completed_at,briefing_updated_at,context_version
  ) values (
    p.client_id,p.id,v_entity,p.template_id,p.completed_at,p.updated_at,v_version
  ) returning id into v_context;
  return v_context;
end;
$$;

create or replace function agency_ops.enqueue_ad_radar_run(
  p_product_id uuid,
  p_trigger text default 'MANUAL',
  p_trigger_event_id uuid default null,
  p_force boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
declare
  v_context uuid;
  v_run uuid;
  v_version text;
  v_key text;
  v_provider text;
begin
  if not coalesce((select enabled from agency_ops.ad_radar_runtime_config where id=1),false) then
    raise exception 'ad_radar_disabled';
  end if;
  v_context := agency_ops.ad_radar_context_for_product(p_product_id);
  select context_version into v_version from agency_ops.ad_radar_product_contexts where id=v_context;
  select provider into v_provider from agency_ops.ad_radar_runtime_config where id=1;
  v_key := case
    when p_trigger_event_id is not null then 'BRIEFING:'||p_trigger_event_id::text
    when upper(p_trigger)='SCHEDULED' and not p_force then 'SCHEDULED:'||v_context::text||':'||current_date::text
    else upper(coalesce(nullif(p_trigger,''),'MANUAL'))||':'||v_context::text||':'||gen_random_uuid()::text
  end;

  insert into agency_ops.ad_radar_runs(context_id,trigger_type,trigger_event_id,idempotency_key,provider,run_version)
  values(v_context,upper(coalesce(nullif(p_trigger,''),'MANUAL')),p_trigger_event_id,v_key,coalesce(v_provider,'FOREPLAY'),v_version)
  on conflict(idempotency_key) do update set updated_at=agency_ops.ad_radar_runs.updated_at
  returning id into v_run;
  return v_run;
end;
$$;

create or replace function agency_ops.enqueue_ad_radar_from_briefing()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
begin
  if new.event_type='BRIEFING_SUBMITTED'
     and new.product_id is not null
     and coalesce((select enabled and auto_briefing_enabled from agency_ops.ad_radar_runtime_config where id=1),false)
  then
    perform agency_ops.enqueue_ad_radar_run(new.product_id,'BRIEFING_SUBMITTED',new.id,false);
  end if;
  return new;
exception when others then
  raise warning 'Radar enqueue skipped for briefing event %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_enqueue_ad_radar_from_briefing on public.briefing_events;
create trigger trg_enqueue_ad_radar_from_briefing
after insert on public.briefing_events
for each row execute function agency_ops.enqueue_ad_radar_from_briefing();

create or replace function agency_ops.claim_ad_radar_runs(p_limit integer default 2)
returns setof agency_ops.ad_radar_runs
language plpgsql
security definer
set search_path = pg_catalog, agency_ops
as $$
begin
  return query
  with picked as (
    select r.id
      from agency_ops.ad_radar_runs r
     where r.status in ('WAITING','FAILED_RECOVERABLE')
       and r.available_at <= now()
       and r.attempts < r.max_attempts
     order by r.requested_at
     for update skip locked
     limit greatest(1,least(coalesce(p_limit,2),10))
  ), upd as (
    update agency_ops.ad_radar_runs r
       set status='SEARCHING', attempts=r.attempts+1, started_at=coalesce(r.started_at,now()),
           locked_at=now(), updated_at=now(), error_code=null, error_detail=null
      from picked p where r.id=p.id
    returning r.*
  )
  select * from upd;
end;
$$;

create or replace function agency_ops.recover_stale_ad_radar_runs()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, agency_ops
as $$
declare v_count integer;
begin
  update agency_ops.ad_radar_runs
     set status=case when attempts>=max_attempts then 'ACTION_REQUIRED' else 'FAILED_RECOVERABLE' end,
         available_at=case when attempts>=max_attempts then available_at else now()+make_interval(mins=>least(60,5*greatest(attempts,1))) end,
         error_code='STALE_RUN_RECOVERED',
         error_detail='Execução interrompida recuperada pelo watchdog.',
         locked_at=null, updated_at=now()
   where status in ('SEARCHING','ANALYZING')
     and coalesce(locked_at,started_at,updated_at) < now()-interval '25 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function agency_ops.ad_radar_direction_to_work_item(p_direction_id uuid, p_actor text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, agency_ops
as $$
declare d agency_ops.ad_radar_directions%rowtype; c agency_ops.ad_radar_product_contexts%rowtype; w uuid;
begin
  perform pg_advisory_xact_lock(hashtext('ad_radar_direction:'||p_direction_id::text));
  select * into d from agency_ops.ad_radar_directions where id=p_direction_id;
  if not found then raise exception 'direction_not_found'; end if;
  select * into c from agency_ops.ad_radar_product_contexts where id=d.context_id;
  select id into w from agency_ops.work_items where source='ad_radar' and source_id='direction:'||d.id::text limit 1;
  if w is not null then return w; end if;
  insert into agency_ops.work_items(
    client_id,type,status,priority,title,description,source,source_id,created_by_person,target_role,metadata,created_at,updated_at
  ) values (
    c.client_id,'CREATIVE_REQUEST','OPEN','MEDIUM',
    'Direcionamento do Radar de Anúncios',
    concat_ws(E'\n\n',d.argument,d.suggested_call,d.hypothesis),
    'ad_radar','direction:'||d.id::text,coalesce(nullif(p_actor,''),'Radar de Anúncios'),'DESIGN',
    jsonb_build_object('ad_radar_direction_id',d.id,'briefing_product_id',c.briefing_product_id),now(),now()
  ) returning id into w;
  insert into agency_ops.ad_radar_links(context_id,direction_id,work_item_id,link_type)
  values(c.id,d.id,w,'DIRECTION_TO_TASK');
  return w;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'ad_radar_runtime_config','ad_radar_product_entities','ad_radar_product_contexts','ad_radar_runs',
    'ad_radar_queries','ad_radar_advertisers','ad_radar_ads','ad_radar_media','ad_radar_matches',
    'ad_radar_match_overrides','ad_radar_observations','ad_radar_analyses','ad_radar_saved_references',
    'ad_radar_feedback','ad_radar_directions','ad_radar_links','ad_radar_pilot_cases'
  ] loop
    execute format('alter table agency_ops.%I enable row level security',t);
    execute format('revoke all on agency_ops.%I from anon, authenticated',t);
    execute format('grant all on agency_ops.%I to service_role',t);
  end loop;
end $$;

revoke all on function agency_ops.ad_radar_context_for_product(uuid) from public, anon, authenticated;
revoke all on function agency_ops.enqueue_ad_radar_run(uuid,text,uuid,boolean) from public, anon, authenticated;
revoke all on function agency_ops.claim_ad_radar_runs(integer) from public, anon, authenticated;
revoke all on function agency_ops.recover_stale_ad_radar_runs() from public, anon, authenticated;
revoke all on function agency_ops.ad_radar_direction_to_work_item(uuid,text) from public, anon, authenticated;
grant execute on function agency_ops.ad_radar_context_for_product(uuid) to service_role;
grant execute on function agency_ops.enqueue_ad_radar_run(uuid,text,uuid,boolean) to service_role;
grant execute on function agency_ops.claim_ad_radar_runs(integer) to service_role;
grant execute on function agency_ops.recover_stale_ad_radar_runs() to service_role;
grant execute on function agency_ops.ad_radar_direction_to_work_item(uuid,text) to service_role;
