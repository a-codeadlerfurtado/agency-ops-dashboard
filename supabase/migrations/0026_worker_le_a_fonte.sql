-- Imobi-Board 0026 - o que o worker precisa saber sobre a fonte
--
-- Duas leituras que so o service_role faz, ambas por hash do token:
--
-- 1. fonte_ativa: usada no handshake da Meta. Sem isso o endpoint devolveria
--    o hub.challenge para qualquer par (k, verify_token) igual, e o ADMIN
--    receberia "conectado" na Meta com um token que ja foi regerado aqui.
--
-- 2. token_da_pagina: o webhook de Lead Ads so entrega o leadgen_id. Nome e
--    telefone exigem uma chamada a Graph API com token de pagina, e esse
--    token nunca pode passar pelo navegador -- so o worker le.

create or replace function imobi_board.fonte_ativa(p_token_sha256 text)
returns boolean
language sql stable security definer set search_path = ''
as $fn$
  select exists (
    select 1 from imobi_board.ingest_sources
    where token_sha256 = p_token_sha256 and active
  );
$fn$;

create or replace function imobi_board.token_da_pagina(p_token_sha256 text)
returns text
language sql stable security definer set search_path = ''
as $fn$
  select page_access_token from imobi_board.ingest_sources
  where token_sha256 = p_token_sha256 and active;
$fn$;

revoke execute on function imobi_board.fonte_ativa(text) from public;
revoke execute on function imobi_board.token_da_pagina(text) from public;
grant execute on function imobi_board.fonte_ativa(text) to service_role;
grant execute on function imobi_board.token_da_pagina(text) to service_role;
