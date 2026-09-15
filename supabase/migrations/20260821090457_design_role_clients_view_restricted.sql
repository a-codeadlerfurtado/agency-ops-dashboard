-- Designers podem abrir a aba Clientes, mas a API devolve somente o nome e
-- quantos dias o cliente esta com a agencia. A autorizacao do detalhe continua
-- bloqueada no servidor; esta migration cuida apenas da presenca da aba no menu.

insert into agency_ops.dashboard_view_permissions
  (view_key, scope_type, scope_value, allowed, note)
values
  ('clients', 'ROLE', 'DESIGN', true,
   'visao restrita: nome + dias como cliente (aplicado no payload da API)')
on conflict (view_key, scope_type, scope_value)
do update set
  allowed = excluded.allowed,
  note = excluded.note,
  updated_at = now();
