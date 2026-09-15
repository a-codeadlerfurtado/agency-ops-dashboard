-- Leonardo passa a usar a mesma Central Criativa e o mesmo escopo de leitura do Adler.
update agency_ops.dashboard_view_permissions
set allowed = true,
    note = 'Central Criativa completa: mesmo escopo de leitura do Adler',
    updated_at = now()
where view_key = 'creative'
  and scope_type = 'ROLE'
  and scope_value = 'COMMERCIAL';

insert into agency_ops.dashboard_view_permissions (view_key, scope_type, scope_value, allowed, note, updated_at)
select 'creative', 'PERSON', 'Leonardo Augusto', true,
       'Central Criativa completa: mesmo escopo de leitura do Adler', now()
where not exists (
  select 1
  from agency_ops.dashboard_view_permissions
  where view_key = 'creative'
    and scope_type = 'PERSON'
    and scope_value = 'Leonardo Augusto'
);

update agency_ops.dashboard_view_permissions
set allowed = true,
    note = 'Central Criativa completa: mesmo escopo de leitura do Adler',
    updated_at = now()
where view_key = 'creative'
  and scope_type = 'PERSON'
  and scope_value = 'Leonardo Augusto';
