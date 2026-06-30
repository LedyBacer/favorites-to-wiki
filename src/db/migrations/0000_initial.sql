CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE telegram_message_type AS ENUM ('text', 'photo', 'document', 'voice', 'video', 'unknown');
CREATE TYPE record_type AS ENUM ('note', 'task', 'task_list', 'bookmark', 'deal', 'temporary_artifact', 'file', 'work_context', 'knowledge', 'idea', 'event', 'unknown');
CREATE TYPE attachment_download_status AS ENUM ('pending', 'downloaded', 'failed', 'skipped_too_large');
CREATE TYPE processing_job_status AS ENUM ('pending', 'running', 'completed', 'failed');

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id bigint NOT NULL,
  telegram_message_id integer NOT NULL,
  telegram_user_id bigint NOT NULL,
  telegram_date timestamptz NOT NULL,
  current_text text,
  message_type telegram_message_type NOT NULL,
  forward_origin_type text,
  forward_sender_name text,
  forward_sender_username text,
  forward_chat_title text,
  forward_date timestamptz,
  reply_to_telegram_message_id integer,
  reply_to_message_id uuid,
  last_telegram_edit_date timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_telegram_identity_uq UNIQUE (telegram_chat_id, telegram_message_id)
);

CREATE INDEX messages_chat_message_idx ON messages (telegram_chat_id, telegram_message_id);
CREATE INDEX messages_text_search_idx ON messages USING gin (to_tsvector('simple', coalesce(current_text, '')));

CREATE TABLE message_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version integer NOT NULL,
  telegram_edit_date timestamptz,
  text text,
  content_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_versions_message_version_uq UNIQUE (message_id, version),
  CONSTRAINT message_versions_message_hash_uq UNIQUE (message_id, content_hash)
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  telegram_file_id text NOT NULL,
  telegram_file_unique_id text NOT NULL,
  original_file_name text,
  mime_type text,
  size_bytes bigint,
  local_path text,
  sha256 text,
  download_status attachment_download_status NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_unique_file_uq UNIQUE (telegram_file_unique_id)
);

CREATE INDEX attachments_filename_search_idx ON attachments USING gin (to_tsvector('simple', coalesce(original_file_name, '')));

CREATE TABLE bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bundle_messages (
  bundle_id uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position integer NOT NULL,
  CONSTRAINT bundle_messages_bundle_message_uq UNIQUE (bundle_id, message_id)
);

CREATE TABLE records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type record_type NOT NULL DEFAULT 'unknown',
  title text,
  body text,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_kind text NOT NULL,
  from_id uuid NOT NULL,
  to_kind text NOT NULL,
  to_id uuid NOT NULL,
  type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  status processing_job_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  run_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
