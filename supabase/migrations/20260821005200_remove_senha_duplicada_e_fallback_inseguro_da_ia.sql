-- (1) SENHA DE BANCO EM TEXTO ABERTO, DUPLICADA
--
-- A senha do papel agency_ops_ai_reader vivia em DOIS lugares: no Vault
-- (criptografada) e em automation_settings (texto aberto). Verificado antes de
-- mexer: agency_ops.get_ai_reader_password() devolve a senha, e ela e' identica
-- a' copia em texto aberto - ou seja, a copia e' pura redundancia perigosa.
--
-- O proprio codigo ja' previa isso. Em agency-ops-run-readonly-sql:
--   "A senha do papel de leitura vive no Vault, nao em automation_settings - de la'
--    qualquer select na tabela a devolvia em texto aberto. O fallback existe apenas
--    durante a transicao e sai quando a linha antiga for removida."
-- Esta e' a remocao que faltava.
delete from agency_ops.automation_settings where key = 'AI_READER_DB_PASSWORD';

-- (2) ROTA DE FALLBACK DA IA, SEM AUTENTICACAO
--
-- agency-ops-ai-ask escolhe o destino assim:
--   webhookUrl = AI_ASK_ENDPOINT_URL ?? MAKE_AI_ASK_WEBHOOK_URL
-- e manda AI_ASK_READ_SECRET no cabecalho para quem ganhar.
--
-- O webhook do Make aceita qualquer POST sem autenticacao (testado: HTTP 200
-- "Accepted"). Enquanto ele estiver configurado, sumir com AI_ASK_ENDPOINT_URL -
-- um erro de digitacao, uma limpeza de config - faz a pergunta do colaborador, o
-- contexto do cliente e o segredo de leitura irem para uma URL publica, em silencio
-- e sem erro na tela.
--
-- Renomeia em vez de apagar: a rota sai do ar (o codigo procura pelo nome exato),
-- o valor continua recuperavel, e fica escrito por que ele foi aposentado. Se a
-- rota direta cair, a IA agora falha ALTO ("OpsQuestion nao esta configurado").
update agency_ops.automation_settings
   set key = 'MAKE_AI_ASK_WEBHOOK_URL_APOSENTADO',
       value = value,
       updated_at = now()
 where key = 'MAKE_AI_ASK_WEBHOOK_URL';
