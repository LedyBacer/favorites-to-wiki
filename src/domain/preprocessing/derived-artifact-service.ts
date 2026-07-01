import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { derivedArtifactType } from "../../db/schema.js";
import { hashDerivedContent } from "./hash.js";

export type DerivedArtifactType = (typeof derivedArtifactType.enumValues)[number];

export interface UpsertDerivedArtifactInput {
  sourceKind: string;
  sourceId: string;
  artifactType: DerivedArtifactType;
  artifactKey?: string | undefined;
  content: object;
  metadata?: Record<string, unknown> | undefined;
}

export class DerivedArtifactService {
  constructor(private readonly db: Database) {}

  async upsert(input: UpsertDerivedArtifactInput) {
    const artifactKey = input.artifactKey ?? "default";
    const contentHash = hashDerivedContent(input.content);
    await this.db.execute(sql`
      insert into derived_artifacts (
        source_kind,
        source_id,
        artifact_type,
        artifact_key,
        content_hash,
        content,
        metadata,
        updated_at
      )
      values (
        ${input.sourceKind},
        ${input.sourceId},
        ${input.artifactType}::derived_artifact_type,
        ${artifactKey},
        ${contentHash},
        ${JSON.stringify(input.content)}::jsonb,
        ${JSON.stringify(input.metadata ?? {})}::jsonb,
        now()
      )
      on conflict (source_kind, source_id, artifact_type, artifact_key)
      do update set
        content_hash = excluded.content_hash,
        content = excluded.content,
        metadata = excluded.metadata,
        updated_at = now()
    `);
  }
}
