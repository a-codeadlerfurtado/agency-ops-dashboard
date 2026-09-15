-- Executar como postgres/admin do cluster.
-- A API continua usando imobi_app SEM SUPERUSER/BYPASSRLS.
-- Este papel NOLOGIN existe somente para ser owner de uma funcao resolver estreita.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'imobi_resolver') THEN
    CREATE ROLE imobi_resolver NOLOGIN BYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO imobi_resolver;
GRANT SELECT (id, tenant_id, phone_number_id, status) ON whatsapp_accounts TO imobi_resolver;

CREATE OR REPLACE FUNCTION resolve_whatsapp_account(p_phone_number_id text)
RETURNS TABLE (tenant_id uuid, whatsapp_account_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT wa.tenant_id, wa.id
    FROM whatsapp_accounts wa
   WHERE wa.phone_number_id = p_phone_number_id
     AND wa.status = 'ATIVO'
   LIMIT 1;
$$;

ALTER FUNCTION resolve_whatsapp_account(text) OWNER TO imobi_resolver;
REVOKE ALL ON FUNCTION resolve_whatsapp_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_account(text) TO imobi_app;
