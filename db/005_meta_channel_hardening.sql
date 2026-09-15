ALTER TABLE whatsapp_accounts
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_last_error text;

UPDATE message_templates SET status='APROVADO' WHERE status='APPROVED';
UPDATE message_templates SET status='REJEITADO' WHERE status='REJECTED';
UPDATE message_templates SET status='PAUSADO' WHERE status IN ('PAUSED','DISABLED');
UPDATE message_templates SET status='PENDENTE' WHERE status IN ('PENDING','IN_APPEAL');

CREATE INDEX IF NOT EXISTS whatsapp_accounts_token_check_idx
  ON whatsapp_accounts (token_last_verified_at)
  WHERE status='ATIVO';