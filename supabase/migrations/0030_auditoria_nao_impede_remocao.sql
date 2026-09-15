-- Imobi-Board 0030 - remover uma imobiliaria era impossivel
--
-- Achado tentando apagar uma imobiliaria de teste. Nao falha em `tenants`:
-- falha nos filhos. O cascade remove o tenant e depois apaga pipelines,
-- filas, convites e o resto; o trigger de auditoria dispara em cada um desses
-- e tenta gravar audit_logs.tenant_id apontando para o tenant que acabou de
-- sumir. A FK recusa e a operacao inteira aborta.
--
-- Consequencia pratica: cliente que cancela nao pode ser removido. Nem por
-- SQL -- so desligando trigger na mao.
--
-- A correcao e nao auditar linha cujo tenant ja nao existe. A alternativa
-- seria largar a FK de audit_logs, mas ai o log ganharia tenant_id orfao e
-- deixaria de servir para o que ele existe.

create or replace function imobi_board_priv.auditar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_tenant uuid;
  v_id     uuid;
  v_antes  jsonb;
  v_depois jsonb;
begin
  v_antes  := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_depois := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_tenant := coalesce(v_depois ->> 'tenant_id', v_antes ->> 'tenant_id')::uuid;
  v_id     := coalesce(v_depois ->> 'id',        v_antes ->> 'id')::uuid;

  if v_tenant is null then
    return null;
  end if;

  -- UPDATE que nao mudou nada de relevante nao vira linha de auditoria
  if tg_op = 'UPDATE' and v_antes - 'updated_at' = v_depois - 'updated_at' then
    return null;
  end if;

  -- Remocao em cascata: o tenant ja saiu e o log ficaria pendurado no vazio.
  -- Sem esta saida, apagar uma imobiliaria e impossivel.
  if tg_op = 'DELETE'
     and not exists (select 1 from imobi_board.tenants t where t.id = v_tenant) then
    return null;
  end if;

  insert into imobi_board.audit_logs
    (tenant_id, actor_user_id, action, entity_type, entity_id, before, after)
  values (v_tenant, (select auth.uid()), tg_op, tg_table_name, v_id,
          v_antes - 'updated_at', v_depois - 'updated_at');
  return null;
end;
$fn$;
