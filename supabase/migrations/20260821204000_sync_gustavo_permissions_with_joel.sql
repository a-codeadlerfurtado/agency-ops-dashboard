-- Gustavo (CS) deve ter exatamente o mesmo nivel de acesso e os mesmos overrides
-- nominais de permissao de Joel Antoniete (CS). Mantemos perfis, logins e dados
-- pessoais separados; apenas a matriz de acesso/visibilidade e espelhada.

-- Mesmo nivel base de acesso.
update agency_ops.team_roster g
   set access_level = j.access_level
  from agency_ops.team_roster j
 where g.person = 'Gustavo Lima'
   and j.person = 'Joel Antoniete'
   and g.role = 'CS'
   and j.role = 'CS';

-- Remove qualquer excecao pessoal antiga do Gustavo e copia as excecoes do Joel.
delete from agency_ops.dashboard_view_permissions
 where scope_type = 'PERSON'
   and scope_value = 'Gustavo Lima';

insert into agency_ops.dashboard_view_permissions
  (view_key, scope_type, scope_value, allowed, note, updated_at)
select view_key,
       'PERSON',
       'Gustavo Lima',
       allowed,
       'espelho do perfil de Joel Antoniete',
       now()
  from agency_ops.dashboard_view_permissions
 where scope_type = 'PERSON'
   and scope_value = 'Joel Antoniete'
on conflict (view_key, scope_type, scope_value)
do update set
  allowed = excluded.allowed,
  note = excluded.note,
  updated_at = now();
