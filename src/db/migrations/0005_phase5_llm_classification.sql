ALTER TYPE derived_artifact_type ADD VALUE IF NOT EXISTS 'llm_classification';
ALTER TYPE derived_artifact_type ADD VALUE IF NOT EXISTS 'image_description';

ALTER TABLE records ADD COLUMN IF NOT EXISTS proposal_key text;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS proposal_key text;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS proposal_key text;

CREATE UNIQUE INDEX IF NOT EXISTS records_proposal_key_uq
  ON records (proposal_key);

CREATE UNIQUE INDEX IF NOT EXISTS entities_proposal_key_uq
  ON entities (proposal_key);

CREATE UNIQUE INDEX IF NOT EXISTS relations_proposal_key_uq
  ON relations (proposal_key);
