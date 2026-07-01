DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'review_status') THEN
    CREATE TYPE review_status AS ENUM ('proposed', 'accepted', 'rejected', 'superseded');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'auto_bundle_status') THEN
    CREATE TYPE auto_bundle_status AS ENUM ('open', 'closed', 'superseded');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'clarification_status') THEN
    CREATE TYPE clarification_status AS ENUM ('pending', 'answered', 'dismissed', 'superseded');
  END IF;
END $$;

ALTER TABLE bundles
  ADD COLUMN IF NOT EXISTS status auto_bundle_status NOT NULL DEFAULT 'closed',
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

ALTER TABLE records
  ADD COLUMN IF NOT EXISTS status review_status NOT NULL DEFAULT 'proposed',
  ADD COLUMN IF NOT EXISTS source_bundle_id uuid REFERENCES bundles(id) ON DELETE SET NULL;

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS status review_status NOT NULL DEFAULT 'proposed';

ALTER TABLE relations
  ADD COLUMN IF NOT EXISTS status review_status NOT NULL DEFAULT 'proposed';

UPDATE records
SET status = coalesce((metadata->>'status')::review_status, 'proposed'::review_status)
WHERE metadata ? 'status'
  AND metadata->>'status' IN ('proposed', 'accepted', 'rejected', 'superseded');

UPDATE entities
SET status = coalesce((metadata->>'status')::review_status, 'proposed'::review_status)
WHERE metadata ? 'status'
  AND metadata->>'status' IN ('proposed', 'accepted', 'rejected', 'superseded');

UPDATE relations
SET status = coalesce((metadata->>'status')::review_status, 'proposed'::review_status)
WHERE metadata ? 'status'
  AND metadata->>'status' IN ('proposed', 'accepted', 'rejected', 'superseded');

CREATE INDEX IF NOT EXISTS bundles_auto_status_idx
  ON bundles (status, updated_at)
  WHERE metadata->>'createdBy' = 'auto_bundle_service';

CREATE INDEX IF NOT EXISTS records_review_status_idx
  ON records (status, updated_at);

CREATE INDEX IF NOT EXISTS records_source_bundle_idx
  ON records (source_bundle_id);

CREATE TABLE IF NOT EXISTS review_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL,
  previous_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  new_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  telegram_user_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_actions_target_idx
  ON review_actions (target_kind, target_id, created_at);

CREATE TABLE IF NOT EXISTS clarification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  generation_key text NOT NULL,
  question text NOT NULL,
  question_hash text NOT NULL,
  status clarification_status NOT NULL DEFAULT 'pending',
  answer text,
  answer_telegram_message_id bigint,
  answered_by_telegram_user_id bigint,
  answered_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS clarification_requests_active_source_uq
  ON clarification_requests (source_kind, source_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS clarification_requests_question_uq
  ON clarification_requests (source_kind, source_id, provider, model, generation_key, question_hash);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  last_cycle_started_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_duration_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
