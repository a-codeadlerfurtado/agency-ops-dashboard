-- Papel AI (Head de IA) + entrada de Filipe Azevedo, Leonardo Augusto e Gabriel Castro.
--
-- O papel precisa entrar nas duas checks E na lista de secoes do front. Se ficasse
-- so no banco, a pessoa apareceria sem secao na aba Equipe - exatamente o bug que
-- escondeu o Vitor Hugo e o time de Design.
--
-- Atencao: a aba Equipe monta o quadro a partir de employee_capacity, nao de
-- team_roster. Quem so entra no roster ganha login mas nao aparece no quadro.
alter table agency_ops.employee_capacity drop constraint if exists employee_capacity_role_check;
alter table agency_ops.employee_capacity add constraint employee_capacity_role_check
  check (role = any (array['CS','GT','DESIGN','AI','MGMT']));

alter table agency_ops.team_roster drop constraint if exists team_roster_role_check;
alter table agency_ops.team_roster add constraint team_roster_role_check
  check (role = any (array['GT','CS','DESIGN','AI','MGMT']));

create or replace function agency_ops.handle_new_user_provision()
returns trigger language plpgsql security definer set search_path = agency_ops, public as $$
declare
  v_person text := nullif(trim(new.raw_user_meta_data->>'collaborator_person'), '');
  v_role_label text;
  v_valid boolean := false;
begin
  if v_person is null then return new; end if;
  select true, case r.role
    when 'GT' then 'Gestor de Tráfego' when 'CS' then 'Customer Success'
    when 'DESIGN' then 'Design' when 'AI' then 'Head de IA'
    when 'MGMT' then 'Gestão' else 'Colaborador' end
  into v_valid, v_role_label
  from agency_ops.team_roster r where r.person = v_person and r.is_former = false;
  if not v_valid then return new; end if;
  insert into agency_ops.user_preferences (user_key, name, role, email, collaborator_person)
  values (new.id::text, v_person, coalesce(v_role_label,'Colaborador'), new.email, v_person)
  on conflict (user_key) do nothing;
  return new;
end; $$;

insert into agency_ops.employee_capacity (person, role, date, source)
select v.person, v.role, current_date, 'cadastro_manual'
from (values ('Leonardo Augusto','MGMT'), ('Gabriel Castro','AI')) as v(person, role)
where not exists (select 1 from agency_ops.employee_capacity e where e.person = v.person);

insert into agency_ops.team_roster (person, role, access_level, clickup_user, email, is_former) values
  ('Filipe Azevedo',  'DESIGN','RESTRICTED','Filipe Azevedo',  'filipetomaz360@gmail.com',       false),
  ('Leonardo Augusto','MGMT',  'FULL',      'Leonardo Augusto','lakassessoriadigital@gmail.com', false),
  ('Gabriel Castro',  'AI',    'FULL',      'Gabriel Castro',  'gabrielcastrodesouza1@gmail.com',false)
on conflict (person) do update
  set role=excluded.role, access_level=excluded.access_level, clickup_user=excluded.clickup_user,
      email=excluded.email, is_former=false, updated_at=now();

insert into agency_ops.team_login_emails (email, person, note) values
  ('filipetomaz360@gmail.com',        'Filipe Azevedo',   'e-mail do ClickUp, confirmado pelo gestor'),
  ('lakassessoriadigital@gmail.com',  'Leonardo Augusto', 'Founder'),
  ('gabrielcastrodesouza1@gmail.com', 'Gabriel Castro',   'Head de IA'),
  ('gabrieldevmkt@gmail.com',         'Gabriel Castro',   'e-mail do ClickUp')
on conflict (email) do update set person=excluded.person, active=true, note=excluded.note;

insert into agency_ops.team_identities (person, system, external_id, external_name, verified, matched_by) values
  ('Leonardo Augusto','CLICKUP','164696807','Leonardo Augusto', true,'clickup_email'),
  ('Gabriel Castro',  'CLICKUP','101705282','Gabriel Castro',   true,'clickup_email')
on conflict (system, external_id) do nothing;
