-- Radar de Anuncios: enqueue from the real product completion state.
-- briefing_events is currently unused in production, so completion must be observed on briefing_products itself.

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
  v_trigger text;
begin
  if not coalesce((select enabled from agency_ops.ad_radar_runtime_config where id=1),false) then
    raise exception 'ad_radar_disabled';
  end if;

  v_context := agency_ops.ad_radar_context_for_product(p_product_id);
  select context_version into v_version from agency_ops.ad_radar_product_contexts where id=v_context;
  select provider into v_provider from agency_ops.ad_radar_runtime_config where id=1;
  v_trigger := upper(coalesce(nullif(p_trigger,''),'MANUAL'));

  v_key := case
    when p_trigger_event_id is not null then 'BRIEFING:'||p_trigger_event_id::text
    when v_trigger='BRIEFING_COMPLETED' and not p_force then 'BRIEFING_COMPLETED:'||v_context::text||':'||v_version
    when v_trigger='SCHEDULED' and not p_force then 'SCHEDULED:'||v_context::text||':'||current_date::text
    else v_trigger||':'||v_context::text||':'||gen_random_uuid()::text
  end;

  insert into agency_ops.ad_radar_runs(
    context_id,trigger_type,trigger_event_id,idempotency_key,provider,run_version
  )
  values(
    v_context,v_trigger,p_trigger_event_id,v_key,coalesce(v_provider,'FOREPLAY'),v_version
  )
  on conflict(idempotency_key) do update
    set idempotency_key=excluded.idempotency_key
  returning id into v_run;

  return v_run;
end;
$$;

create or replace function agency_ops.enqueue_ad_radar_from_product_completion()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, agency_ops
as $$
begin
  if new.archived_at is null
     and new.completed_at is not null
     and upper(coalesce(new.completion_status,''))='COMPLETO'
     and coalesce((select enabled and auto_briefing_enabled from agency_ops.ad_radar_runtime_config where id=1),false)
     and (
       tg_op='INSERT'
       or old.completed_at is null
       or old.completed_at is distinct from new.completed_at
       or upper(coalesce(old.completion_status,'')) is distinct from upper(coalesce(new.completion_status,''))
     )
  then
    perform agency_ops.enqueue_ad_radar_run(new.id,'BRIEFING_COMPLETED',null,false);
  end if;
  return new;
exception when others then
  raise warning 'Radar enqueue skipped for completed product %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_enqueue_ad_radar_from_product_completion on public.briefing_products;
create trigger trg_enqueue_ad_radar_from_product_completion
after insert or update of completed_at, completion_status
on public.briefing_products
for each row execute function agency_ops.enqueue_ad_radar_from_product_completion();

revoke all on function agency_ops.enqueue_ad_radar_run(uuid,text,uuid,boolean) from public,anon,authenticated;
revoke all on function agency_ops.enqueue_ad_radar_from_product_completion() from public,anon,authenticated;
grant execute on function agency_ops.enqueue_ad_radar_run(uuid,text,uuid,boolean) to service_role;
