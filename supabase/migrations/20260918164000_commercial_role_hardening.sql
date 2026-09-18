-- Consolida os papeis comerciais e remove privilegio global legado do closer.
update agency_ops.team_roster
set role='CLOSER', access_level='RESTRICTED', updated_at=now()
where person='Vitor Feitoza' and is_former=false;

update agency_ops.user_preferences
set role='CLOSER', updated_at=now()
where collaborator_person='Vitor Feitoza';

update public.profiles
set sees_all_leads=false
where lower(email)='feitozaluizvitor@gmail.com';

update agency_ops.team_roster
set role='SDR', access_level='RESTRICTED', updated_at=now()
where person='Gustavo Lima' and is_former=false;

update agency_ops.user_preferences
set role='SDR', updated_at=now()
where collaborator_person='Gustavo Lima';

-- Remove herancas de visualizacao do antigo perfil CS do SDR.
delete from agency_ops.dashboard_view_permissions
where scope_type='PERSON'
  and scope_value='Gustavo Lima';
