ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS quality_score text,
  ADD COLUMN IF NOT EXISTS meta_event text,
  ADD COLUMN IF NOT EXISTS rejection_details jsonb,
  ADD COLUMN IF NOT EXISTS meta_last_event_at timestamptz;

CREATE OR REPLACE FUNCTION resolve_whatsapp_waba(p_waba_id text)
RETURNS TABLE (tenant_id uuid, whatsapp_account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT wa.tenant_id, wa.id
  FROM whatsapp_accounts wa
  WHERE wa.waba_id = p_waba_id
    AND wa.status = 'ATIVO'
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION resolve_whatsapp_waba(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_waba(text) TO imobi_app;

CREATE TABLE IF NOT EXISTS whatsapp_billing_usage (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  wamid text NOT NULL,
  recipient_id text,
  meta_status text,
  pricing_model text,
  pricing_category text,
  pricing_type text,
  billable boolean,
  meta_timestamp timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wamid)
);
CREATE INDEX IF NOT EXISTS whatsapp_billing_usage_tenant_time_idx
  ON whatsapp_billing_usage (tenant_id, meta_timestamp DESC);
CREATE INDEX IF NOT EXISTS whatsapp_billing_usage_tenant_billable_idx
  ON whatsapp_billing_usage (tenant_id, billable, pricing_category);
ALTER TABLE whatsapp_billing_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_billing_usage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON whatsapp_billing_usage;
CREATE POLICY tenant_isolation ON whatsapp_billing_usage
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
