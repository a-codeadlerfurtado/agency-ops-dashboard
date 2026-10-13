-- ImobiBoard - fontes Meta para reconciliacao de seguranca
-- Somente o Worker (service_role) pode ler tokens/cursors de ingestao.

create or replace function imobi_board.fontes_meta_para_reconciliar()
returns table (
  id uuid,
  tenant_id uuid,
  token_sha256 text,
  page_id text,
  page_access_token text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select s.id, s.tenant_id, s.token_sha256, s.page_id, s.page_access_token
  from imobi_board.ingest_sources s
  join imobi_board.tenants t on t.id = s.tenant_id
  where s.active
    and s.integration = 'META_ADS'
    and t.status = 'ACTIVE'
    and s.page_id is not null
    and s.page_access_token is not null;
$fn$;

revoke execute on function imobi_board.fontes_meta_para_reconciliar() from public;
revoke execute on function imobi_board.fontes_meta_para_reconciliar() from anon;
revoke execute on function imobi_board.fontes_meta_para_reconciliar() from authenticated;
grant execute on function imobi_board.fontes_meta_para_reconciliar() to service_role;
