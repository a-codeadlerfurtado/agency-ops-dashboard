create or replace function agency_ops.sync_onboarding_gt_choice_to_recommendation()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
begin
  if new.assigned_gt is distinct from old.assigned_gt
     or new.assigned_at is distinct from old.assigned_at
     or new.assigned_by is distinct from old.assigned_by then
    update agency_ops.onboarding_gt_recommendations
       set chosen_gt = new.assigned_gt,
           chosen_by = new.assigned_by,
           chosen_at = new.assigned_at,
           updated_at = now()
     where request_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_onboarding_gt_choice_to_recommendation
  on agency_ops.onboarding_gt_assignment_requests;

create trigger trg_sync_onboarding_gt_choice_to_recommendation
after update of assigned_gt, assigned_by, assigned_at
on agency_ops.onboarding_gt_assignment_requests
for each row execute function agency_ops.sync_onboarding_gt_choice_to_recommendation();

comment on function agency_ops.sync_onboarding_gt_choice_to_recommendation() is
'Audita a decisao humana de atribuicao de GT. O motor de recomendacao nao atribui automaticamente.';
