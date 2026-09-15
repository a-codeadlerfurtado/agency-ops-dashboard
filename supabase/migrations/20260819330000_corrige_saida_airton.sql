-- Airton: a saida real e' 27/07, nao 19/08.
--
-- O lifecycle dele oscilou no crm_sync (marcou CHURNED com saida 19/08, depois voltou
-- para ACTIVE), e eu tinha reportado o churn de 19/08 como se fosse real. Era artefato
-- da sincronizacao. Cruzando as duas pontas que o gestor apontou:
--
--   ultima task no ClickUp .... 21/07
--   ultima mensagem no grupo .. 29/07 ("Bom dia", sem assunto)
--   cancelamento ............... 27/07 as 10:56
--
-- Em 27/07 ele escreve no grupo que vai abortar o trafego pago: nao trouxe nenhum
-- cliente para o stand da incorporadora e ficou sem caixa para investir. No mesmo dia,
-- de manha, tinha reclamado do volume (2 leads por $300). Essa e' a data do churn - as
-- tasks pararam 6 dias antes e as mensagens morreram 2 dias depois, o que fecha.
--
-- 48 dias de permanencia. Acima dos 10 dias, entao conta como churn e nao venda caida.
update agency_ops.clients
   set lifecycle = 'CHURNED', saida = date '2026-07-27', updated_at = now()
 where id = '8eb79011-e572-415f-ab05-a2973ba53737'
   and (saida is distinct from date '2026-07-27' or lifecycle <> 'CHURNED');

-- O gatilho de churn gravou o log sozinho; aqui so entra o motivo, com a evidencia.
update agency_ops.client_churn_log
   set motivo = 'Cancelou o trafego pago em 27/07 as 10:56 no grupo do WhatsApp: nao trouxe nenhum cliente para o stand da incorporadora e ficou sem caixa para investir. Reclamacao de volume de leads no mesmo dia (2 leads por $300). Ultima task 21/07, ultima mensagem 29/07.'
 where client_id = '8eb79011-e572-415f-ab05-a2973ba53737' and motivo is null;
