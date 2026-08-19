-- handle_new_user_provision criava perfil em agency_ops para CADA usuario do Auth,
-- incluindo os do imobi-pro (909 em 30 dias). Com o gatilho de notificacao isso
-- viraria ~30 alertas/dia no sino de gente que nao e' do dashboard.
-- A funcao vive em agency_ops, nao em public.
drop function if exists public.handle_new_user_provision();

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
    when 'DESIGN' then 'Design' when 'MGMT' then 'Gestão' else 'Colaborador' end
  into v_valid, v_role_label
  from agency_ops.team_roster r where r.person = v_person and r.is_former = false;
  if not v_valid then return new; end if;
  insert into agency_ops.user_preferences (user_key, name, role, email, collaborator_person)
  values (new.id::text, v_person, coalesce(v_role_label,'Colaborador'), new.email, v_person)
  on conflict (user_key) do nothing;
  return new;
end; $$;

create or replace function agency_ops.user_signup_notify()
returns trigger language plpgsql security definer set search_path = agency_ops, public as $$
begin
  if new.collaborator_person is null then return new; end if;
  begin
    insert into agency_ops.access_requests (user_key, person, status, kind, note)
    values (new.user_key, new.collaborator_person, 'PENDING', 'SIGNUP',
            coalesce(new.email,'') || ' se cadastrou como ' || new.collaborator_person || '.');
  exception when others then null; end;
  return new;
end; $$;
