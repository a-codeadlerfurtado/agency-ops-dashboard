-- Central de Trabalho: permite encaminhamento nominal para CS/Design e
-- protege GT pelo responsável real da carteira do cliente.

create or replace function agency_ops.normalize_work_item_role_scope()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
declare
  v_role text;
begin
  -- CS e DESIGN podem receber demanda nominalmente. Se target_person vier
  -- preenchido, ele precisa existir no roster ativo e pertencer ao papel correto.
  -- Se vier nulo, preservamos o comportamento legado para automações antigas.
  if new.target_role in ('CS','DESIGN') and nullif(new.target_person,'') is not null then
    select role into v_role
    from agency_ops.team_roster
    where person = new.target_person and is_former = false
    limit 1;

    if v_role is distinct from new.target_role then
      raise exception 'WORK_ITEM_ASSIGNEE_ROLE_MISMATCH';
    end if;
  end if;

  -- Para demanda de cliente enviada a GT, a carteira é a fonte de verdade.
  if new.target_role = 'GT' and new.client_id is not null then
    select c.gt_owner into new.target_person
    from agency_ops.clients c
    where c.id = new.client_id;
  end if;

  return new;
end;
$$;

create or replace function agency_ops.validate_dashboard_work_item_assignee()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
declare
  v_gt text;
begin
  -- Só endurece solicitações criadas manualmente pela Central de Trabalho.
  -- Automações/backfills antigos continuam compatíveis.
  if coalesce(new.source,'dashboard') <> 'dashboard' then
    return new;
  end if;

  if new.target_role = 'GT' then
    if new.client_id is null then
      raise exception 'GT_ASSIGNMENT_REQUIRES_CLIENT';
    end if;
    select gt_owner into v_gt from agency_ops.clients where id = new.client_id;
    if nullif(v_gt,'') is null then
      raise exception 'CLIENT_WITHOUT_GT_OWNER';
    end if;
    new.target_person := v_gt;

  elsif new.target_role = 'CS' then
    if new.target_person not in ('Joel Antoniete','Gustavo Lima') then
      raise exception 'INVALID_CS_ASSIGNEE';
    end if;

  elsif new.target_role = 'DESIGN' then
    if new.target_person not in ('Davi Henrique','Davi Nycollas','Filipe Azevedo') then
      raise exception 'INVALID_DESIGN_ASSIGNEE';
    end if;

  elsif new.target_role = 'MGMT' then
    new.target_person := 'Adler Furtado';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_dashboard_work_item_assignee on agency_ops.work_items;
create trigger trg_validate_dashboard_work_item_assignee
before insert or update of client_id,target_role,target_person,source
on agency_ops.work_items
for each row execute function agency_ops.validate_dashboard_work_item_assignee();
