create table if not exists agency_ops.meta_creative_catalog (
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  meta_ad_account_id text not null,
  ad_id text not null,
  ad_name text,
  client_name text,
  lifecycle text,
  campaign_id text,
  campaign_name text,
  campaign_status text,
  adset_id text,
  adset_name text,
  ad_status text,
  creative_id text,
  creative_name text,
  creative_format text not null default 'DESCONHECIDO',
  effective_object_story_id text,
  preview_storage_path text,
  thumbnail_url text,
  image_url text,
  spend_7d numeric,
  impressions_7d bigint,
  clicks_7d bigint,
  ctr_7d numeric,
  frequency_7d numeric,
  leads_7d numeric,
  results_7d numeric,
  cost_per_result_7d numeric,
  result_type text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  is_current boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  primary key (client_id, meta_ad_account_id, ad_id)
);

alter table agency_ops.meta_creative_catalog add column if not exists ad_name text;
create index if not exists meta_creative_catalog_client_idx on agency_ops.meta_creative_catalog(client_id, is_current);
create index if not exists meta_creative_catalog_campaign_idx on agency_ops.meta_creative_catalog(campaign_id, is_current);
create index if not exists meta_creative_catalog_format_idx on agency_ops.meta_creative_catalog(creative_format, is_current);
create index if not exists meta_creative_catalog_sync_idx on agency_ops.meta_creative_catalog(last_synced_at desc);

create table if not exists agency_ops.meta_creative_catalog_sync_state (
  client_id uuid primary key references agency_ops.clients(id) on delete cascade,
  status text not null default 'PENDING',
  ad_count integer not null default 0,
  account_count integer not null default 0,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists agency_ops.creative_designer_capabilities (
  person text primary key,
  can_video boolean not null default false,
  updated_at timestamptz not null default now(),
  notes text
);

insert into agency_ops.creative_designer_capabilities(person,can_video,notes)
values
  ('Davi Henrique', true, 'Editor de vídeo atual'),
  ('Davi Nycollas', false, 'Não atribuir autoria de vídeo sem revisão humana'),
  ('Filipe Azevedo', false, 'Não atribuir autoria de vídeo sem revisão humana')
on conflict (person) do update set can_video=excluded.can_video, updated_at=now(), notes=excluded.notes;

create or replace function agency_ops.invoke_meta_creative_catalog_sync(p_client_id uuid)
returns bigint
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  v_req bigint;
begin
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-meta-creative-catalog-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'x-meta-campaign-secret', agency_ops.get_internal_secret('META_CAMPAIGN_SYNC_SECRET')
    ),
    body := jsonb_build_object('client_id', p_client_id::text),
    timeout_milliseconds := 120000
  ) into v_req;
  return v_req;
end;
$$;

revoke all on function agency_ops.invoke_meta_creative_catalog_sync(uuid) from public, anon, authenticated;
grant execute on function agency_ops.invoke_meta_creative_catalog_sync(uuid) to service_role;

create or replace function agency_ops.enqueue_meta_creative_catalog_sync(p_limit integer default 12, p_stale_hours integer default 20)
returns integer
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select c.id
    from agency_ops.clients c
    where c.lifecycle in ('ACTIVE','ONBOARDING')
      and exists (
        select 1 from agency_ops.client_integrations ci
        where ci.client_id=c.id and ci.system='META_BM' and ci.meta_ad_account_id is not null
      )
      and not exists (
        select 1 from agency_ops.meta_creative_catalog_sync_state s
        where s.client_id=c.id
          and (
            s.status in ('QUEUED','RUNNING')
            or (s.status='OK' and s.finished_at > now() - make_interval(hours => greatest(1,p_stale_hours)))
          )
      )
    order by coalesce((select s2.finished_at from agency_ops.meta_creative_catalog_sync_state s2 where s2.client_id=c.id), '1970-01-01'::timestamptz), c.display_name
    limit greatest(1,least(coalesce(p_limit,12),30))
  loop
    insert into agency_ops.meta_creative_catalog_sync_state(client_id,status,updated_at,metadata)
    values(r.id,'QUEUED',now(),jsonb_build_object('queued_at',now()))
    on conflict(client_id) do update set status='QUEUED',updated_at=now(),last_error=null,metadata=agency_ops.meta_creative_catalog_sync_state.metadata || jsonb_build_object('queued_at',now());
    perform agency_ops.invoke_meta_creative_catalog_sync(r.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function agency_ops.enqueue_meta_creative_catalog_sync(integer,integer) from public, anon, authenticated;
grant execute on function agency_ops.enqueue_meta_creative_catalog_sync(integer,integer) to service_role;

DO $$
DECLARE j record;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname='meta-creative-catalog-refresh' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

select cron.schedule(
  'meta-creative-catalog-refresh',
  '17 * * * *',
  $$select agency_ops.enqueue_meta_creative_catalog_sync(12,20);$$
);

grant select on agency_ops.meta_creative_catalog to service_role;
grant select,insert,update on agency_ops.meta_creative_catalog_sync_state to service_role;
grant select on agency_ops.creative_designer_capabilities to service_role;
