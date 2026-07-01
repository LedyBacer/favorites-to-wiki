CREATE TYPE derived_artifact_type AS ENUM (
  'normalized_text',
  'extracted_metadata',
  'file_metadata',
  'link_preview',
  'ocr_text',
  'transcript',
  'embedding_reference'
);

ALTER TABLE processing_jobs
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE INDEX IF NOT EXISTS processing_jobs_claim_idx
  ON processing_jobs (status, run_after, created_at);

CREATE INDEX IF NOT EXISTS processing_jobs_locked_idx
  ON processing_jobs (status, locked_at);

CREATE TABLE derived_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  artifact_type derived_artifact_type NOT NULL,
  artifact_key text NOT NULL DEFAULT 'default',
  content_hash text NOT NULL,
  content jsonb NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT derived_artifacts_source_artifact_uq UNIQUE (
    source_kind,
    source_id,
    artifact_type,
    artifact_key
  )
);

CREATE INDEX derived_artifacts_source_idx
  ON derived_artifacts (source_kind, source_id);

CREATE INDEX derived_artifacts_type_idx
  ON derived_artifacts (artifact_type);
