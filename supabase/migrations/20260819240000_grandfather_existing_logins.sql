-- A trava de aprovacao de cadastro (20260819230000) exige um access_request SIGNUP
-- aprovado para qualquer login. Contas criadas ANTES da trava nao tem esse registro
-- e foram bloqueadas: o payload inteiro vinha zerado (0 clientes, 0 conversas, todos
-- os KPIs em 0). Regressao observada em producao com a conta do gestor.
--
-- Backfill retroativo. A regra continua estrita de proposito: sem SIGNUP aprovado,
-- sem acesso. Falhar fechado e' o comportamento certo para uma trava de acesso.
insert into agency_ops.access_requests (user_key, person, status, kind, note, decided_at, decided_by)
select p.user_key, p.collaborator_person, 'APPROVED', 'SIGNUP',
       'Conta anterior a trava de aprovacao; liberada retroativamente.', now(), 'sistema'
from agency_ops.user_preferences p
where not exists (
  select 1 from agency_ops.access_requests r
   where r.user_key = p.user_key and r.kind = 'SIGNUP'
);
