CREATE TABLE IF NOT EXISTS chatwoot_conversation_links (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  chatwoot_account_id bigint NOT NULL,
  chatwoot_inbox_id bigint NOT NULL,
  chatwoot_conversation_id bigint NOT NULL,
  contact_source_id text NOT NULL,
  chatwoot_contact_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id),
  UNIQUE (chatwoot_account_id, chatwoot_conversation_id)
);
CREATE INDEX IF NOT EXISTS chatwoot_links_tenant_cw_idx
  ON chatwoot_conversation_links (tenant_id, chatwoot_conversation_id);
ALTER TABLE chatwoot_conversation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_conversation_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chatwoot_conversation_links;
CREATE POLICY tenant_isolation ON chatwoot_conversation_links
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
CREATE OR REPLACE FUNCTION resolve_chatwoot_bridge(p_account_id bigint, p_inbox_id bigint)
RETURNS TABLE (tenant_id uuid, integration_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.tenant_id, i.id
  FROM integrations i
  WHERE i.tipo='CHATWOOT'
    AND i.provedor='chatwoot'
    AND i.ativo=true
    AND (i.config->>'accountId')::bigint = p_account_id
    AND (i.config->>'inboxId')::bigint = p_inbox_id
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION resolve_chatwoot_bridge(bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_chatwoot_bridge(bigint,bigint) TO imobi_app;

CREATE TABLE IF NOT EXISTS chatwoot_webhook_deliveries (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  event text,
  chatwoot_message_id bigint,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, delivery_id)
);
ALTER TABLE chatwoot_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chatwoot_webhook_deliveries;
CREATE POLICY tenant_isolation ON chatwoot_webhook_deliveries
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
