-- Chave de dashboard nao passa por aprovacao, nao tem carteira e nao tem dono: quem
-- a possui e' tratado como acesso total, e ainda pode APROVAR cadastro de outros
-- (canDecideAccessRequests e' true quando nao ha login). Ou seja, uma chave vazada
-- vale mais que uma senha vazada.
--
-- Havia 7 ativas. Quatro nunca autenticaram uma vez sequer - last_used_at nulo, e o
-- codigo grava esse campo a cada uso bem-sucedido -, entao desativa-las nao pode
-- quebrar nada que algum dia funcionou. Duas delas ja' estavam vencidas desde 18/08
-- e continuavam marcadas como ativas; as outras duas sao duplicatas sem validade,
-- o pior formato possivel: permanente e esquecida.
--
-- Ficam de pe' as que tem uso registrado (sites-dashboard-v2 e "Dashboard web
-- automatico") e a clickup-sync-cron, criada hoje e que ainda nao rodou pela
-- primeira vez.
update agency_ops.dashboard_api_keys
   set active = false
 where active
   and last_used_at is null
   and label <> 'clickup-sync-cron';
