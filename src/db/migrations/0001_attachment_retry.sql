ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_unique_file_uq;

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS download_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_download_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS attachments_message_file_uq
  ON attachments (message_id, telegram_file_unique_id);

CREATE INDEX IF NOT EXISTS attachments_unique_file_idx
  ON attachments (telegram_file_unique_id);

CREATE INDEX IF NOT EXISTS attachments_retry_idx
  ON attachments (download_status, next_retry_at);
