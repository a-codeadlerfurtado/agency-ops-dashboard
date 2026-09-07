insert into agency_ops.automation_settings(key,value,description,updated_at)
values('VIDEO_ANALYSIS_ENABLED','false'::jsonb,'Kill switch central para claims do backfill temporal de vídeos. Deve permanecer false até smoke remoto do worker V3 e validação controlada.',now())
on conflict (key) do update set value='false'::jsonb, description=excluded.description, updated_at=now();

create or replace function agency_ops.claim_creative_video_analysis(p_worker_id text)
returns agency_ops.creative_video_analysis
language plpgsql
security definer
set search_path to 'agency_ops','public','pg_catalog'
as $function$
declare
  r agency_ops.creative_video_analysis;
  enabled boolean;
begin
  select coalesce((value #>> '{}')::boolean,false)
    into enabled
  from agency_ops.automation_settings
  where key='VIDEO_ANALYSIS_ENABLED';

  if not coalesce(enabled,false) then
    return null;
  end if;

  select * into r
  from agency_ops.creative_video_analysis
  where analysis_status in ('PENDING','RETRY')
    and available_at <= now()
  order by priority desc, created_at asc
  for update skip locked
  limit 1;

  if r.id is null then
    return null;
  end if;

  update agency_ops.creative_video_analysis
  set analysis_status='RUNNING',
      worker_id=p_worker_id,
      locked_at=now(),
      heartbeat_at=now(),
      attempts=attempts+1,
      updated_at=now()
  where id=r.id
  returning * into r;

  return r;
end;
$function$;

revoke all on function agency_ops.claim_creative_video_analysis(text) from public;
revoke all on function agency_ops.claim_creative_video_analysis(text) from anon;
revoke all on function agency_ops.claim_creative_video_analysis(text) from authenticated;
grant execute on function agency_ops.claim_creative_video_analysis(text) to service_role;

revoke all on function agency_ops.requeue_stale_video_analysis(integer,integer) from public;
revoke all on function agency_ops.requeue_stale_video_analysis(integer,integer) from anon;
revoke all on function agency_ops.requeue_stale_video_analysis(integer,integer) from authenticated;
grant execute on function agency_ops.requeue_stale_video_analysis(integer,integer) to service_role;
