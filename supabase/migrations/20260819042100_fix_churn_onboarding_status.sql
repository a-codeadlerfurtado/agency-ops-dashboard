create or replace function agency_ops.close_onboarding_after_churn()
returns trigger language plpgsql security definer set search_path = agency_ops, public as $$
begin
  if new.lifecycle in ('CHURNED','PRE_OPS_CHURN') and old.lifecycle is distinct from new.lifecycle then
    update agency_ops.onboarding_cases set status='ABORTED',closed_at=coalesce(new.saida::timestamptz,now()),
      metadata=metadata||jsonb_build_object('closed_reason','CLIENT_CHURNED','closed_automatically',true),updated_at=now()
    where client_id=new.id and status='OPEN';
  end if;
  return new;
end $$;
