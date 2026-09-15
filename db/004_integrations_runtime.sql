ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_sync_at timestamptz;

CREATE INDEX IF NOT EXISTS integrations_due_sync_idx
  ON integrations (next_sync_at)
  WHERE ativo=true AND tipo='XML';

UPDATE integrations
   SET next_sync_at=COALESCE(next_sync_at, now())
 WHERE tipo='XML' AND ativo=true;
