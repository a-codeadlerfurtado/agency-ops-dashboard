-- Imobi-Board 0042 - o console lia a ligacao pela porta errada
--
-- Sintoma: "Definir senha" na Central respondia "Ligue a imobiliaria a um
-- cliente do Agency Ops antes", enquanto o card ao lado exibia
-- "cliente: Caio Montenegro". As duas telas liam fontes diferentes.
--
-- A listagem usa central_do_crm(), SECURITY DEFINER, que le a tabela como
-- postgres e enxerga tudo. O DEFINIR_SENHA lia imobi_board.tenants direto pelo
-- PostgREST com a chave de servico -- e service_role NAO tem SELECT nessa
-- tabela. Os grants sao postgres e authenticated; a migracao 0031 concedeu
-- USAGE no schema e nunca as tabelas. service_role ignora RLS, mas ignorar RLS
-- nao ajuda quando falta o GRANT.
--
-- Duas correcoes possiveis: conceder SELECT a service_role, ou fechar a leitura
-- numa funcao. Fica a funcao. Conceder abriria a tabela inteira ao PostgREST
-- para qualquer coisa que use a chave de servico, e o resto do console ja fala
-- por RPC -- essa leitura direta era a excecao, e era ela que estava quebrada.
--
-- Devolve tambem o nome do cliente: quem chama precisa disso para a mensagem, e
-- assim nao ha uma segunda consulta atras do mesmo dado.

create or replace function imobi_board.cliente_do_tenant(p_tenant uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare v_cliente uuid; v_nome text; v_tenant text;
begin
  select t.agency_client_id, t.name into v_cliente, v_tenant
    from imobi_board.tenants t where t.id = p_tenant;

  if v_tenant is null then
    raise exception 'Imobiliaria % nao existe.', p_tenant using errcode = 'P0002';
  end if;

  select c.display_name into v_nome
    from agency_ops.clients c where c.id = v_cliente;

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'imobiliaria', v_tenant,
    'agency_client_id', v_cliente,
    'cliente', v_nome);
end;
$fn$;

revoke execute on function imobi_board.cliente_do_tenant(uuid) from public, authenticated;
grant  execute on function imobi_board.cliente_do_tenant(uuid) to service_role;
