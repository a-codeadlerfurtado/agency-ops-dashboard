-- Somente GT possui carteira/roteamento por cliente.
-- CS e DESIGN atendem as tres carteiras; work items desses papeis sao da equipe,
-- nao de um pseudo-responsavel fixo do cliente.

create or replace function agency_ops.normalize_work_item_role_scope()
returns trigger
language plpgsql
as $$
begin
  if new.target_role in ('CS','DESIGN') then
    new.target_person := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_normalize_work_item_role_scope on agency_ops.work_items;
create trigger trg_normalize_work_item_role_scope
before insert or update of target_role, target_person
on agency_ops.work_items
for each row execute function agency_ops.normalize_work_item_role_scope();

update agency_ops.work_items
set target_person = null
where target_role in ('CS','DESIGN')
  and target_person is not null
  and status in ('OPEN','IN_PROGRESS','WAITING','SNOOZED');

comment on function agency_ops.normalize_work_item_role_scope() is
'Impede pseudo-carteira de CS/DESIGN: demandas desses papeis sao role-level; apenas GT e roteado por carteira/cliente.';
