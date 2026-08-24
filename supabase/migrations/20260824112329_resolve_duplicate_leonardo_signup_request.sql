update agency_ops.access_requests ar
set status='DENIED',
    decided_at=now(),
    decided_by='Adler Furtado',
    note=coalesce(ar.note||' · ','')||'Solicitação duplicada encerrada; acesso da Direção Comercial já aprovado.'
where ar.user_key=(select up.user_key from agency_ops.user_preferences up where up.collaborator_person='Leonardo Augusto' limit 1)
  and ar.kind='SIGNUP'
  and ar.status='PENDING'
  and exists (
    select 1 from agency_ops.access_requests ok
    where ok.user_key=ar.user_key and ok.kind='SIGNUP' and ok.status='APPROVED'
  );
