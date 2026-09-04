-- Imobi-Board 0031 - o worker nunca conseguiu falar com o banco
--
-- Desde a 0001 o schema foi aberto a `authenticated`, e o `service_role`
-- ficou de fora. Todas as funcoes que o worker chama tinham EXECUTE, o que
-- dava a impressao de estar certo -- mas sem USAGE no schema o Postgres nem
-- chega a resolver o nome da funcao.
--
-- Isso escondeu o problema por semanas por um detalhe cruel: "permission
-- denied for schema" usa errcode 42501, o MESMO de "Credencial de ingestao
-- invalida" que a nossa propria funcao levanta. O worker casava pelo codigo,
-- nao pela mensagem, e respondia 401 "credencial invalida" -- mandando
-- procurar erro no token quando o token nunca tinha sido lido.
--
-- Nao ha risco de RLS aqui: service_role ja ignora RLS por natureza, e a
-- superficie dele continua sendo so as funcoes com EXECUTE concedido --
-- USAGE no schema nao concede nada por si.

grant usage on schema imobi_board      to service_role;
grant usage on schema imobi_board_priv to service_role;

-- `anon` continua de fora: sem sessao a superficie e zero, e a 0022 deixou
-- uma assercao justamente para isso.
do $$
begin
  if has_schema_privilege('anon', 'imobi_board', 'usage') then
    raise exception 'anon ganhou USAGE no schema imobi_board - regressao de seguranca';
  end if;
  if not has_schema_privilege('service_role', 'imobi_board', 'usage') then
    raise exception 'service_role continua sem USAGE - o worker nao vai funcionar';
  end if;
end $$;
