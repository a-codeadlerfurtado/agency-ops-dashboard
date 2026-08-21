-- FALHA CRITICA DE ACESSO, confirmada com chamada real e sem login.
--
-- As tabelas de agency_ops estao corretamente fechadas: anon e authenticated levam
-- 401/403 em todas. Mas as FUNCOES nao estavam. Em Postgres, funcao nova nasce com
-- EXECUTE para PUBLIC, e como agency_ops precisa estar exposto ao PostgREST (as edge
-- functions falam com o banco por ali), toda funcao virou endpoint /rest/v1/rpc/...
-- acessivel com a chave publicavel - que esta dentro do bundle JavaScript do site.
--
-- Verificado na pratica: POST /rest/v1/rpc/contract_private_summary, sem token de
-- usuario nenhum, devolveu HTTP 200 com o resumo de contratos - a mesma area que tem
-- lista nominal no backend porque "nem FULL basta". A porta dos fundos ignorava tudo.
--
-- Alem da leitura, estavam abertas funcoes de ESCRITA e de EFEITO EXTERNO:
--   ingest_whatsapp_message  - injetar mensagem falsa no historico do cliente
--   ingest_ops_note          - injetar anotacao
--   ingest_meeting_transcript- injetar transcricao de reuniao
--   upsert_alert             - criar alerta arbitrario
--   enqueue_notification     - disparar notificacao (inclusive para WhatsApp)
--   set_contract_term        - alterar vigencia de contrato
--   link_contract_to_client  - religar contrato a outro cliente
--   notify_*                 - forcar envio real de mensagem
--   invoke_meta_*            - disparar chamada e custo na API da Meta
--
-- Correcao: ninguem de fora chama RPC de agency_ops. O navegador so' fala com edge
-- function, e a edge function usa service_role (que ignora esses grants). Entao
-- revoga-se EXECUTE de PUBLIC/anon/authenticated em bloco.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as assinatura
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'agency_ops'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.assinatura);
  end loop;
end $$;

-- Sem isto o buraco volta sozinho: a proxima funcao criada em agency_ops nasceria de
-- novo com EXECUTE para PUBLIC.
alter default privileges in schema agency_ops revoke execute on functions from public;

-- service_role continua com o que precisa: e' quem as edge functions usam.
grant usage on schema agency_ops to service_role;
grant execute on all functions in schema agency_ops to service_role;
alter default privileges in schema agency_ops grant execute on functions to service_role;
