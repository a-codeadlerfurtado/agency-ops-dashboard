drop index if exists agency_ops.heavy_jobs_claim_idx;
create index if not exists heavy_jobs_claim_idx
  on agency_ops.heavy_jobs(available_at, created_at)
  where status = 'PENDING';

create or replace function agency_ops.enqueue_heavy_job(
  p_job_type text,
  p_payload jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_max_attempts integer default 5,
  p_available_at timestamptz default now()
) returns uuid
language plpgsql
security definer
set search_path = agency_ops, pgmq, public
as $$
declare
  v_id uuid;
  v_existing uuid;
  v_delay integer;
begin
  p_job_type := upper(trim(coalesce(p_job_type,'')));
  if p_job_type = '' or p_job_type !~ '^[A-Z0-9_:-]{2,80}$' then
    raise exception 'invalid_job_type';
  end if;
  p_max_attempts := greatest(1, least(coalesce(p_max_attempts,5),20));
  p_available_at := coalesce(p_available_at, now());

  if nullif(trim(coalesce(p_dedupe_key,'')),'') is not null then
    select id into v_existing
      from agency_ops.heavy_jobs
     where job_type = p_job_type
       and dedupe_key = p_dedupe_key
       and status in ('PENDING','RUNNING')
     order by created_at desc
     limit 1;
    if v_existing is not null then return v_existing; end if;
  end if;

  begin
    insert into agency_ops.heavy_jobs(job_type,payload,dedupe_key,max_attempts,available_at)
    values (p_job_type,coalesce(p_payload,'{}'::jsonb),nullif(trim(coalesce(p_dedupe_key,'')),''),p_max_attempts,p_available_at)
    returning id into v_id;
  exception when unique_violation then
    select id into v_existing
      from agency_ops.heavy_jobs
     where job_type = p_job_type
       and dedupe_key = nullif(trim(coalesce(p_dedupe_key,'')),'')
       and status in ('PENDING','RUNNING')
     order by created_at desc
     limit 1;
    if v_existing is not null then return v_existing; end if;
    raise;
  end;

  v_delay := greatest(0, ceil(extract(epoch from (p_available_at-now())))::integer);
  perform pgmq.send('agency_heavy_jobs', jsonb_build_object('job_id',v_id,'job_type',p_job_type), v_delay);
  return v_id;
end;
$$;

create or replace function agency_ops.claim_heavy_jobs(
  p_worker text,
  p_limit integer default 1,
  p_visibility_timeout integer default 900
) returns table(job_id uuid, message_id bigint, job_type text, payload jsonb, attempt integer, max_attempts integer)
language plpgsql
security definer
set search_path = agency_ops, pgmq, public
as $$
declare
  v_msg pgmq.message_record;
  v_job agency_ops.heavy_jobs%rowtype;
  v_id uuid;
begin
  if nullif(trim(coalesce(p_worker,'')),'') is null then raise exception 'worker_required'; end if;
  p_limit := greatest(1, least(coalesce(p_limit,1),10));
  p_visibility_timeout := greatest(60, least(coalesce(p_visibility_timeout,900),7200));

  for v_msg in select * from pgmq.read('agency_heavy_jobs', p_visibility_timeout, p_limit) loop
    begin v_id := (v_msg.message->>'job_id')::uuid;
    exception when others then
      perform pgmq.delete('agency_heavy_jobs',v_msg.msg_id);
      continue;
    end;

    select * into v_job from agency_ops.heavy_jobs where id=v_id for update;
    if not found or v_job.status in ('SUCCEEDED','CANCELLED','FAILED') then
      perform pgmq.delete('agency_heavy_jobs',v_msg.msg_id);
      continue;
    end if;
    if v_job.available_at > now() then
      perform pgmq.set_vt('agency_heavy_jobs',v_msg.msg_id,greatest(60,ceil(extract(epoch from (v_job.available_at-now())))::integer));
      continue;
    end if;

    update agency_ops.heavy_jobs
       set status='RUNNING', attempts=attempts+1, locked_at=now(), locked_by=trim(p_worker),
           last_error=null, updated_at=now()
     where id=v_id
     returning * into v_job;

    job_id := v_job.id;
    message_id := v_msg.msg_id;
    job_type := v_job.job_type;
    payload := v_job.payload;
    attempt := v_job.attempts;
    max_attempts := v_job.max_attempts;
    return next;
  end loop;
end;
$$;

create or replace function agency_ops.heartbeat_heavy_job(
  p_job_id uuid,
  p_message_id bigint,
  p_worker text,
  p_progress integer default null,
  p_visibility_timeout integer default 900
) returns boolean
language plpgsql
security definer
set search_path = agency_ops, pgmq, public
as $$
declare v_count integer;
begin
  update agency_ops.heavy_jobs
     set progress=coalesce(greatest(0,least(p_progress,99)),progress), updated_at=now()
   where id=p_job_id and status='RUNNING' and locked_by=trim(p_worker);
  get diagnostics v_count = row_count;
  if v_count=0 then return false; end if;
  perform pgmq.set_vt('agency_heavy_jobs',p_message_id,greatest(60,least(coalesce(p_visibility_timeout,900),7200)));
  return true;
end;
$$;

create or replace function agency_ops.complete_heavy_job(
  p_job_id uuid,
  p_message_id bigint,
  p_worker text,
  p_result jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = agency_ops, pgmq, public
as $$
declare v_count integer;
begin
  update agency_ops.heavy_jobs
     set status='SUCCEEDED',progress=100,result=coalesce(p_result,'{}'::jsonb),completed_at=now(),updated_at=now(),locked_at=null,locked_by=null
   where id=p_job_id and status='RUNNING' and locked_by=trim(p_worker);
  get diagnostics v_count = row_count;
  if v_count=0 then return false; end if;
  perform pgmq.delete('agency_heavy_jobs',p_message_id);
  return true;
end;
$$;

create or replace function agency_ops.fail_heavy_job(
  p_job_id uuid,
  p_message_id bigint,
  p_worker text,
  p_error text,
  p_retry_delay_seconds integer default 60
) returns text
language plpgsql
security definer
set search_path = agency_ops, pgmq, public
as $$
declare
  v_job agency_ops.heavy_jobs%rowtype;
  v_delay integer := greatest(5,least(coalesce(p_retry_delay_seconds,60),86400));
begin
  select * into v_job from agency_ops.heavy_jobs where id=p_job_id and status='RUNNING' and locked_by=trim(p_worker) for update;
  if not found then return 'NOT_OWNED'; end if;

  perform pgmq.delete('agency_heavy_jobs',p_message_id);
  if v_job.attempts >= v_job.max_attempts then
    update agency_ops.heavy_jobs
       set status='FAILED',last_error=left(coalesce(p_error,'worker_failed'),4000),completed_at=now(),updated_at=now(),locked_at=null,locked_by=null
     where id=p_job_id;
    return 'FAILED';
  end if;

  update agency_ops.heavy_jobs
     set status='PENDING',last_error=left(coalesce(p_error,'worker_failed'),4000),available_at=now()+make_interval(secs=>v_delay),updated_at=now(),locked_at=null,locked_by=null
   where id=p_job_id;
  perform pgmq.send('agency_heavy_jobs',jsonb_build_object('job_id',p_job_id,'job_type',v_job.job_type),v_delay);
  return 'RETRY';
end;
$$;

revoke all on function agency_ops.enqueue_heavy_job(text,jsonb,text,integer,timestamptz) from public,anon,authenticated;
revoke all on function agency_ops.claim_heavy_jobs(text,integer,integer) from public,anon,authenticated;
revoke all on function agency_ops.heartbeat_heavy_job(uuid,bigint,text,integer,integer) from public,anon,authenticated;
revoke all on function agency_ops.complete_heavy_job(uuid,bigint,text,jsonb) from public,anon,authenticated;
revoke all on function agency_ops.fail_heavy_job(uuid,bigint,text,text,integer) from public,anon,authenticated;
grant execute on function agency_ops.enqueue_heavy_job(text,jsonb,text,integer,timestamptz) to service_role;
grant execute on function agency_ops.claim_heavy_jobs(text,integer,integer) to service_role;
grant execute on function agency_ops.heartbeat_heavy_job(uuid,bigint,text,integer,integer) to service_role;
grant execute on function agency_ops.complete_heavy_job(uuid,bigint,text,jsonb) to service_role;
grant execute on function agency_ops.fail_heavy_job(uuid,bigint,text,text,integer) to service_role;
