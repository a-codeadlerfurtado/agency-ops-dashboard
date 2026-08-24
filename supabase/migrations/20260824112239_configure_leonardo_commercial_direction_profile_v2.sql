-- Leonardo Augusto: Direção Comercial com visão executiva e leitura essencial da operação.
-- Mantemos o papel técnico MGMT para compatibilidade, mas removemos elevação operacional via access_level RESTRICTED.

update agency_ops.team_roster
set access_level = 'RESTRICTED',
    updated_at = now()
where person = 'Leonardo Augusto'
  and coalesce(is_former,false) = false;

insert into agency_ops.user_preferences(
  user_key,name,role,email,collaborator_person,metadata,updated_at
)
select
  u.id::text,
  'Leonardo Augusto',
  'MGMT',
  u.email,
  'Leonardo Augusto',
  jsonb_build_object(
    'profile_mode','COMMERCIAL_DIRECTION',
    'operational_scope','EXECUTIVE_READ_ONLY',
    'configured_by','Adler Furtado'
  ),
  now()
from auth.users u
where lower(u.email) = lower('lakassessoriadigital@gmail.com')
on conflict (user_key) do update
set name = excluded.name,
    role = excluded.role,
    email = excluded.email,
    collaborator_person = excluded.collaborator_person,
    metadata = coalesce(agency_ops.user_preferences.metadata,'{}'::jsonb) || excluded.metadata,
    updated_at = now();

insert into agency_ops.access_requests(
  user_key,person,status,requested_at,decided_at,decided_by,note,kind
)
select
  u.id::text,
  'Leonardo Augusto',
  'APPROVED',
  now(),
  now(),
  'Adler Furtado',
  'Acesso permanente da Direção Comercial ao painel executivo/comercial.',
  'SIGNUP'
from auth.users u
where lower(u.email) = lower('lakassessoriadigital@gmail.com')
  and not exists (
    select 1
    from agency_ops.access_requests ar
    where ar.user_key = u.id::text
      and ar.kind = 'SIGNUP'
      and ar.status = 'APPROVED'
  );

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note,updated_at)
values
  ('overview','PERSON','Leonardo Augusto',true,'Direção Comercial: leitura executiva geral',now()),
  ('preclients','PERSON','Leonardo Augusto',true,'Direção Comercial: pipeline comercial',now()),
  ('clients','PERSON','Leonardo Augusto',true,'Direção Comercial: carteira em modo de leitura',now()),
  ('health','PERSON','Leonardo Augusto',true,'Direção Comercial: saúde e risco dos clientes',now()),
  ('onboarding','PERSON','Leonardo Augusto',true,'Direção Comercial: acompanhamento de onboarding sem execução',now()),
  ('executive','PERSON','Leonardo Augusto',true,'Marca o perfil como executivo',now()),
  ('focus','PERSON','Leonardo Augusto',false,'Evitar microgestão operacional diária',now()),
  ('work','PERSON','Leonardo Augusto',false,'Sem Central de Trabalho operacional',now()),
  ('creative','PERSON','Leonardo Augusto',false,'Sem fila/diretrizes de design',now()),
  ('campaigns','PERSON','Leonardo Augusto',false,'Sem operação detalhada de campanhas',now()),
  ('conversations','PERSON','Leonardo Augusto',false,'Sem leitura operacional de conversas',now()),
  ('team','PERSON','Leonardo Augusto',false,'Sem produtividade individual detalhada',now()),
  ('diary','PERSON','Leonardo Augusto',false,'Sem TaskLog/diário individual',now()),
  ('clickup','PERSON','Leonardo Augusto',false,'Sem gestão de tarefas ClickUp',now()),
  ('evidence','PERSON','Leonardo Augusto',false,'Sem evidências operacionais brutas',now()),
  ('audit','PERSON','Leonardo Augusto',false,'Sem auditoria técnica',now()),
  ('alerts','PERSON','Leonardo Augusto',false,'Sem central de alertas operacionais',now()),
  ('opsperf','PERSON','Leonardo Augusto',false,'Sem desempenho individual da operação',now()),
  ('finance','PERSON','Leonardo Augusto',false,'Financeiro continua exclusivo do Adler',now())
on conflict (view_key,scope_type,scope_value) do update
set allowed = excluded.allowed,
    note = excluded.note,
    updated_at = now();
