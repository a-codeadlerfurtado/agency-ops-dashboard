ALTER TABLE scheduled_jobs
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS scheduled_jobs_processing_idx
  ON scheduled_jobs (claimed_at)
  WHERE status = 'PROCESSANDO';
