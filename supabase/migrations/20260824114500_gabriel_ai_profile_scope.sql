-- Perfil individual do Gabriel Castro (Head de IA): acesso focado na própria operação.
-- O recorte de Saúde por N8N é aplicado na Edge Function agency-ops-client-health.
-- O recorte TaskLog-only é aplicado na Edge Function agency-ops-diary-api.

update agency_ops.team_roster
set access_level = 'RESTRICTED', updated_at = now()
where person = 'Gabriel Castro';

update agency_ops.access_requests
set status = 'DENIED',
    decided_at = now(),
    decided_by = 'Adler Furtado',
    note = 'Escopo individual do Gabriel: sem elevação global'
where person = 'Gabriel Castro'
  and kind = 'ELEVATION'
  and status = 'APPROVED';

insert into agency_ops.dashboard_view_permissions
  (view_key, scope_type, scope_value, allowed, note, updated_at)
values
  ('preclients',     'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem funil comercial', now()),
  ('opsperf',        'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem Desempenho OP', now()),
  ('audit',          'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem Auditoria', now()),
  ('evidence',       'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem Evidências', now()),
  ('team',           'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem Equipe', now()),
  ('conversations',  'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem Conversas', now()),
  ('campaigns',      'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem Campanhas', now()),
  ('onboarding',     'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem Onboarding', now()),
  ('creative',       'PERSON', 'Gabriel Castro', false, 'Perfil IA Gabriel: sem Central Criativa', now()),
  ('clickup',        'PERSON', 'Gabriel Castro', true,  'Perfil IA Gabriel: ClickUp somente pessoal via escopo RESTRICTED', now()),
  ('diary',          'PERSON', 'Gabriel Castro', true,  'Perfil IA Gabriel: chave interna usada exclusivamente como TaskLog', now()),
  ('health',         'PERSON', 'Gabriel Castro', true,  'Perfil IA Gabriel: somente clientes IA com N8N ativo', now()),
  ('overview',       'PERSON', 'Gabriel Castro', true,  'Perfil IA Gabriel', now()),
  ('focus',          'PERSON', 'Gabriel Castro', true,  'Perfil IA Gabriel', now()),
  ('work',           'PERSON', 'Gabriel Castro', true,  'Perfil IA Gabriel', now()),
  ('alerts',         'PERSON', 'Gabriel Castro', true,  'Perfil IA Gabriel', now())
on conflict (view_key, scope_type, scope_value)
do update set
  allowed = excluded.allowed,
  note = excluded.note,
  updated_at = excluded.updated_at;
