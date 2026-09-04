-- Imobi-Board 0040 - qual item do cofre pertence a este usuario
--
-- Ao definir a senha de alguem, o console precisa saber se cria um item novo
-- no cofre ou atualiza o que ja existe. Sem isso, cada troca de senha deixaria
-- mais um item para o mesmo acesso, e o cofre viraria uma lista de senhas
-- antigas onde ninguem sabe qual vale.
--
-- A chave e o proprio usuario, nao o nome do sistema: dois corretores da mesma
-- imobiliaria tem itens com nome parecido e so o user_id os separa.

create or replace function imobi_board.item_no_cofre(p_user_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $fn$
  select s.vault_item_id from imobi_board.senhas_no_cofre s where s.user_id = p_user_id;
$fn$;

revoke execute on function imobi_board.item_no_cofre(uuid) from public, authenticated;
grant execute on function imobi_board.item_no_cofre(uuid) to service_role;
