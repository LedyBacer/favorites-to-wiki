CREATE TABLE IF NOT EXISTS embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  source_kind text NOT NULL,
  source_id uuid NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL,
  content_hash text NOT NULL,
  embedding double precision[] NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT embeddings_source_embedding_uq UNIQUE (source_kind, source_id, provider, model),
  CONSTRAINT embeddings_dimensions_positive CHECK (dimensions > 0),
  CONSTRAINT embeddings_vector_dimensions_match CHECK (array_length(embedding, 1) = dimensions)
);

CREATE INDEX IF NOT EXISTS embeddings_source_idx
  ON embeddings (source_kind, source_id);

CREATE INDEX IF NOT EXISTS embeddings_model_idx
  ON embeddings (provider, model);
