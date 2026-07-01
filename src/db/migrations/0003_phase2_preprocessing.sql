ALTER TYPE derived_artifact_type ADD VALUE IF NOT EXISTS 'file_preview';

CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_job_subject_uq
  ON processing_jobs (type, subject_kind, subject_id);
