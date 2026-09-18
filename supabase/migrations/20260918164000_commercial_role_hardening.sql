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

-- Gustavo Lima permanece CS e herda a mesma matriz de acesso do Joel.
update agency_ops.team_roster g
set role='CS',
    access_level=j.access_level,
    updated_at=now()
from agency_ops.team_roster j
where g.person='Gustavo Lima'
  and j.person='Joel Antoniete'
  and j.role='CS'
  and j.is_former=false;

update agency_ops.user_preferences
set role='CS', updated_at=now()
where collaborator_person='Gustavo Lima';

delete from agency_ops.dashboard_view_permissions
where scope_type='PERSON' and scope_value='Gustavo Lima';

insert into agency_ops.dashboard_view_permissions
  (view_key,scope_type,scope_value,allowed,note,updated_at)
select view_key,'PERSON','Gustavo Lima',allowed,
       'espelho do perfil de Joel Antoniete',now()
from agency_ops.dashboard_view_permissions
where scope_type='PERSON' and scope_value='Joel Antoniete'
on conflict (view_key,scope_type,scope_value)
do update set allowed=excluded.allowed,note=excluded.note,updated_at=now();

-- O SDR correto e Gustavo Royce. Perfil criado separado, sem reaproveitar login do CS.
insert into agency_ops.team_roster
  (person,role,access_level,email,clickup_user,is_former,created_at,updated_at)
values
  ('Gustavo Royce','SDR','RESTRICTED',null,null,false,now(),now())
on conflict (person) do update
set role='SDR',
    access_level='RESTRICTED',
    is_former=false,
    updated_at=now();

delete from agency_ops.dashboard_view_permissions
where scope_type='PERSON' and scope_value='Gustavo Royce';
