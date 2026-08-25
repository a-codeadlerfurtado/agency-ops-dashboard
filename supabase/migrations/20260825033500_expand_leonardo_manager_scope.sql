-- Leonardo: direção comercial com gestão ativa em módulos permitidos.
-- Continua sem acesso a conversas, saúde, alertas, ClickUp geral, auditoria,
-- equipe operacional, evidências e demais superfícies de operação.

update agency_ops.dashboard_view_permissions
set allowed = true,
    note = case view_key
      when 'finance' then 'Direção Comercial pode gerenciar termos financeiros'
      when 'onboarding' then 'Direção Comercial pode acompanhar e atualizar onboarding'
      when 'creative' then 'Central Criativa limitada a demandas atribuídas ao Leonardo'
      when 'work' then 'Central de Trabalho limitada a target_person Leonardo Augusto'
      when 'diary' then 'Diário e TaskLog pessoais do Leonardo'
      else note
    end,
    updated_at = now()
where scope_type = 'ROLE'
  and scope_value = 'COMMERCIAL'
  and view_key in ('finance','onboarding','creative','work','diary');

update agency_ops.dashboard_view_permissions
set allowed = false,
    note = 'Operação geral permanece bloqueada para Direção Comercial',
    updated_at = now()
where scope_type = 'ROLE'
  and scope_value = 'COMMERCIAL'
  and view_key in ('alerts','audit','clickup','conversations','evidence','health','opsperf','team','agenda','focus');

update agency_ops.user_preferences
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'scope_model', 'COMMERCIAL_FINANCE_ONBOARDING_ASSIGNED_WORK',
      'access_mode', 'MANAGER',
      'finance_access', 'WRITE',
      'onboarding_access', 'WRITE_PANORAMIC',
      'work_access', 'ASSIGNED_ONLY',
      'creative_access', 'ASSIGNED_ONLY',
      'diary_access', 'SELF_ONLY',
      'tasklog_access', 'SELF_ONLY'
    ),
    updated_at = now()
where collaborator_person = 'Leonardo Augusto';
