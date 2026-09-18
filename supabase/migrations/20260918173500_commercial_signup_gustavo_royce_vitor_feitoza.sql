insert into agency_ops.team_login_emails(email,person,active,note)
values
  ('luisgustavosdr@gmail.com','Gustavo Royce',true,'Conta SDR autorizada pelo gestor'),
  ('feitozaluizvitor@gmail.com','Vitor Feitoza',true,'Conta closer autorizada pelo gestor')
on conflict (email) do update
set person=excluded.person, active=true, note=excluded.note;

create or replace function agency_ops.handle_new_user_provision()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','public'
as $function$
declare
  v_person text := nullif(trim(new.raw_user_meta_data->>'collaborator_person'), '');
  v_role_label text;
  v_valid boolean := false;
begin
  if v_person is null then return new; end if;

  select true,
    case r.role
      when 'GT' then 'Gestor de Tráfego'
      when 'CS' then 'Customer Success'
      when 'DESIGN' then 'Design'
      when 'AI' then 'Head de IA'
      when 'MGMT' then 'Gestão'
      when 'COMMERCIAL' then 'Comercial'
      when 'CLOSER' then 'Closer'
      when 'SDR' then 'SDR'
      else 'Colaborador'
    end
  into v_valid, v_role_label
  from agency_ops.team_roster r
  where r.person=v_person and r.is_former=false;

  if not v_valid then return new; end if;

  insert into agency_ops.user_preferences(user_key,name,role,email,collaborator_person)
  values(new.id::text,v_person,coalesce(v_role_label,'Colaborador'),new.email,v_person)
  on conflict (user_key) do update
  set name=excluded.name,
      role=excluded.role,
      email=excluded.email,
      collaborator_person=excluded.collaborator_person,
      updated_at=now();

  return new;
end;
$function$;
