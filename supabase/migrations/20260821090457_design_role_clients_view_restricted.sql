insert into agency_ops.dashboard_view_permissions
  (subject_type, subject_key, view_key, allowed, notes, updated_at)
values
  ('ROLE', 'DESIGN', 'clients', true, 'visao restrita: nome + dias como cliente (aplicado no payload da API)', now())
on conflict (subject_type, subject_key, view_key)
do update set
  allowed = excluded.allowed,
  notes = excluded.notes,
  updated_at = excluded.updated_at;
