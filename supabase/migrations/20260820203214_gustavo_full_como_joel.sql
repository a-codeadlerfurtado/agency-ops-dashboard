-- Os dois CS atendem a mesma base: nao ha carteira separada entre eles. Manter o
-- Gustavo em RESTRICTED e o Joel em FULL fazia a mesma funcao render telas diferentes
-- (na pratica, o ClickUp: o Joel via a equipe toda, o Gustavo so' a propria linha).
--
-- Isso NAO abre a aba Clientes para ele: quem decide aba e'
-- dashboard_view_permissions, e la' Clientes segue nominal para Adler e Joel.
update agency_ops.team_roster
   set access_level = 'FULL'
 where person = 'Gustavo Lima' and role = 'CS';
