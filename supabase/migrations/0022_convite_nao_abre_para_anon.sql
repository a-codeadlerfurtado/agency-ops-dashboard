-- A 0021 concedeu convite_publico ao anon para a tela do convite mostrar o
-- nome da imobiliaria antes do login. Isso NAO funciona sem dar USAGE no
-- schema ao anon - e essa e uma garantia documentada em docs/security.md:
-- "sem login, a superficie e literalmente zero".
--
-- Trocar essa garantia por um nome de imobiliaria na tela nao paga. A pessoa
-- entra primeiro e o convite e resolvido depois; o texto da tela nao depende
-- de dado nenhum antes da sessao existir.
revoke execute on function imobi_board.convite_publico(text) from anon;

-- confirma que o anon segue sem porta de entrada
do $$
begin
  if has_schema_privilege('anon', 'imobi_board', 'usage') then
    raise exception 'anon ganhou USAGE no schema imobi_board - regressao de seguranca';
  end if;
end $$;
