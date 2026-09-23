-- Radar de Anuncios: bounded scheduled refresh for active products.
-- Uses the existing external-collection kill switch, so nothing is enqueued while the provider is disabled.

create or replace function agency_ops.enqueue_due_ad_radar_refreshes(p_limit integer default 2)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
declare
  cfg agency_ops.ad_radar_runtime_config%rowtype;
  r record;
  v_count integer := 0;
begin
  select * into cfg from agency_ops.ad_radar_runtime_config where id=1;
  if not found or not cfg.enabled or not cfg.external_collection_enabled then
    return 0;
  end if;

  for r in
    select c.briefing_product_id
      from agency_ops.ad_radar_product_contexts c
      join agency_ops.clients cl on cl.id=c.client_id
      join public.briefing_products bp on bp.id=c.briefing_product_id and bp.archived_at is null
      left join lateral (
        select max(rr.requested_at) last_requested
          from agency_ops.ad_radar_runs rr
         where rr.context_id=c.id
      ) lr on true
     where cl.lifecycle in ('ACTIVE','ONBOARDING')
       and not exists (
         select 1 from agency_ops.ad_radar_runs active
          where active.context_id=c.id
            and active.status in ('WAITING','SEARCHING','ANALYZING','FAILED_RECOVERABLE')
       )
       and (lr.last_requested is null or lr.last_requested < now()-make_interval(days=>cfg.refresh_days))
     order by lr.last_requested nulls first, c.updated_at
     limit greatest(1,least(coalesce(p_limit,cfg.max_runs_per_tick),10))
  loop
    perform agency_ops.enqueue_ad_radar_run(r.briefing_product_id,'SCHEDULED',null,false);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function agency_ops.enqueue_due_ad_radar_refreshes(integer) from public, anon, authenticated;
grant execute on function agency_ops.enqueue_due_ad_radar_refreshes(integer) to service_role;
