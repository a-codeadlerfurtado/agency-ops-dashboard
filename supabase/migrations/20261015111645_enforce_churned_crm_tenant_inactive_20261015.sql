-- Already applied to Supabase imobi-pro. Never re-run blindly in production.
CREATE OR REPLACE FUNCTION agency_ops.enforce_churned_tenant_inactive()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'agency_ops', 'imobi_board'
AS $function$
begin
  if new.lifecycle='CHURNED'
     and (tg_op='INSERT' or old.lifecycle is distinct from new.lifecycle) then
    update imobi_board.tenants t
       set status='INACTIVE'::imobi_board.tenant_status,updated_at=now()
     where t.agency_client_id=new.id and t.status::text<>'INACTIVE';
  end if;
  return new;
end;
$function$
;
revoke all on function agency_ops.enforce_churned_tenant_inactive() from public,anon,authenticated;
drop trigger if exists trg_clients_churn_crm_inactive on agency_ops.clients;
create trigger trg_clients_churn_crm_inactive after insert or update of lifecycle on agency_ops.clients for each row execute function agency_ops.enforce_churned_tenant_inactive();
CREATE OR REPLACE FUNCTION imobi_board_priv.guard_churned_tenant_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'agency_ops', 'imobi_board', 'imobi_board_priv'
AS $function$
begin
  if new.agency_client_id is not null
    and new.status::text<>'INACTIVE'
    and exists(select 1 from agency_ops.clients c
               where c.id=new.agency_client_id and c.lifecycle='CHURNED')
  then
    new.status='INACTIVE'::imobi_board.tenant_status;
    new.updated_at=now();
  end if;
  return new;
end;
$function$
;
revoke all on function imobi_board_priv.guard_churned_tenant_status() from public,anon,authenticated;
drop trigger if exists trg_guard_churned_tenant_status on imobi_board.tenants;
create trigger trg_guard_churned_tenant_status before insert or update of status,agency_client_id on imobi_board.tenants for each row execute function imobi_board_priv.guard_churned_tenant_status();
