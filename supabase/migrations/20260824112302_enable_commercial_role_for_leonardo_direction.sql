-- A tabela de permissões já possui o papel COMMERCIAL; o roster ainda não aceitava esse valor.
alter table agency_ops.team_roster drop constraint if exists team_roster_role_check;
alter table agency_ops.team_roster
  add constraint team_roster_role_check
  check (role = any (array['GT'::text,'CS'::text,'DESIGN'::text,'AI'::text,'MGMT'::text,'COMMERCIAL'::text]));

update agency_ops.team_roster
set role = 'COMMERCIAL',
    access_level = 'FULL',
    updated_at = now()
where person = 'Leonardo Augusto'
  and coalesce(is_former,false) = false;

update agency_ops.user_preferences
set role = 'COMMERCIAL',
    metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
      'profile_mode','COMMERCIAL_DIRECTION',
      'operational_scope','EXECUTIVE_READ_ONLY',
      'display_role','Direção Comercial'
    ),
    updated_at = now()
where collaborator_person = 'Leonardo Augusto';
