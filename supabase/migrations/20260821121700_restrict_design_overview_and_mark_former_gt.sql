-- Persist profile restrictions already applied in production.
-- DESIGN must not see the operational overview; the profile starts on Foco do dia.
update agency_ops.dashboard_view_permissions
set allowed = false,
    note = 'Visao geral operacional removida de DESIGN; perfil inicia no Foco do dia',
    updated_at = now()
where scope_type = 'ROLE'
  and scope_value = 'DESIGN'
  and view_key = 'overview';

-- Preserve historical ClickUp/task links while removing former GTs from the active roster.
update agency_ops.team_roster
set is_former = true,
    updated_at = now()
where person in ('Carlos Henrique', 'João Vitor')
  and role = 'GT';
