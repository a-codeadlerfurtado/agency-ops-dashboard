insert into agency_ops.dashboard_view_permissions (view_key, scope_type, scope_value, allowed, note, updated_at)
values
  ('creative', 'PERSON', 'Joel Antoniete', true, 'CS autorizado a editar e confirmar o manual criativo dos clientes', now()),
  ('creative', 'PERSON', 'Gustavo Lima', true, 'CS autorizado a editar e confirmar o manual criativo dos clientes', now())
on conflict (view_key, scope_type, scope_value)
do update set
  allowed = excluded.allowed,
  note = excluded.note,
  updated_at = excluded.updated_at;
