-- Standalone Make delivery for an existing Meta campaign and lead form.
-- One route per Page/form prevents duplicate WhatsApp dispatch.
CREATE TABLE IF NOT EXISTS agency_ops.campaign_make_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES agency_ops.clients(id),
  actor_user_id uuid NOT NULL,
  campaign_id text NOT NULL CHECK (campaign_id ~ '^[0-9]{5,30}$'),
  campaign_name text NOT NULL,
  account_id text NOT NULL CHECK (account_id ~ '^[0-9]{5,30}$'),
  page_id text NOT NULL CHECK (page_id ~ '^[0-9]{5,30}$'),
  form_id text NOT NULL CHECK (form_id ~ '^[0-9]{5,30}$'),
  product text NOT NULL,
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('SINGLE','ROUND_ROBIN')),
  recipient text NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'PROVISIONING'
    CHECK (status IN ('PROVISIONING','READY','ERROR')),
  scenario_id bigint,
  hook_id bigint,
  data_store_id bigint,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, form_id)
);
ALTER TABLE agency_ops.campaign_make_routes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agency_ops.campaign_make_routes FROM anon, authenticated;
GRANT ALL ON agency_ops.campaign_make_routes TO service_role;
CREATE INDEX IF NOT EXISTS campaign_make_routes_client_idx
  ON agency_ops.campaign_make_routes(client_id, created_at DESC);
