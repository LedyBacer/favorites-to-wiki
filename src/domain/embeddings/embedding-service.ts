import { sql } from "drizzle-orm";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { ProcessingJob } from "../../db/schema.js";
import { ProcessingJobService } from "../processing/processing-job-service.js";
import { DerivedArtifactService } from "../preprocessing/derived-artifact-service.js";
import { EmbeddingClient } from "./embedding-client.js";
import { buildMessageEmbeddingSourceText } from "./source-text.js";

export const MESSAGE_EMBEDDING_JOB = "message_embedding";
export const EMBEDDING_JOB_TYPES = [MESSAGE_EMBEDDING_JOB] as const;
export const EMBEDDING_PROVIDER = "ollama";

export interface EmbeddingSummary {
  jobsCreated: number;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  embeddingsWritten: number;
}

export interface SemanticSearchResult extends Record<string, unknown> {
  id: string;
  telegramChatId: number;
  telegramMessageId: number;
  telegramDate: Date | string;
  currentText: string | null;
  messageType: string;
  attachmentNames: string | null;
  similarity: number;
}

export class EmbeddingService {
  private readonly processingJobs: ProcessingJobService;
  private readonly artifacts: DerivedArtifactService;
  private readonly client: EmbeddingClient;

  constructor(
    private readonly db: Database,
    private readonly config: Pick<
      AppConfig,
      | "EMBEDDING_SERVICE_URL"
      | "EMBEDDING_SERVICE_API_KEY"
      | "EMBEDDING_MODEL"
      | "EMBEDDING_DIMENSIONS"
      | "EMBEDDING_SERVICE_TIMEOUT_MS"
      | "EMBEDDING_MAX_INPUT_CHARS"
    >,
  ) {
    this.processingJobs = new ProcessingJobService(db);
    this.artifacts = new DerivedArtifactService(db);
    this.client = new EmbeddingClient({
      baseUrl: config.EMBEDDING_SERVICE_URL,
      apiKey: config.EMBEDDING_SERVICE_API_KEY,
      model: config.EMBEDDING_MODEL,
      dimensions: config.EMBEDDING_DIMENSIONS,
      timeoutMs: config.EMBEDDING_SERVICE_TIMEOUT_MS,
    });
  }

  async enqueueMissing(limit = 100, reindex = false): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error("Embedding enqueue limit must be between 1 and 5000");
    }

    if (reindex) {
      await this.reopenExistingJobs(limit);
    }

    const result = await this.db.execute<{ id: string }>(sql`
      select messages.id
      from messages
      where (
          coalesce(messages.current_text, '') <> ''
          or exists (
            select 1
            from attachments a
            join derived_artifacts da
              on da.source_kind = 'attachment'
              and da.source_id = a.id
              and da.artifact_type in ('ocr_text', 'transcript', 'image_description')
              and coalesce(da.content->>'text', '') <> ''
            where a.message_id = messages.id
          )
          or exists (
            select 1
            from attachments a
            where a.message_id = messages.id
              and a.original_file_name is not null
          )
        )
      order by messages.telegram_date asc, messages.created_at asc
      limit ${limit}
    `);
    let created = 0;
    for (const row of result.rows) {
      const source = await buildMessageEmbeddingSourceText(
        this.db,
        row.id,
        this.config.EMBEDDING_MAX_INPUT_CHARS,
      );
      if (!source?.text) continue;
      const changed = await this.processingJobs.enqueueOrRefresh({
        type: MESSAGE_EMBEDDING_JOB,
        subjectKind: "message",
        subjectId: row.id,
        generationKey: `phase4:${EMBEDDING_PROVIDER}:${this.config.EMBEDDING_MODEL}:v1`,
        inputHash: source.contentHash,
        payload: {
          phase: 4,
          processorVersion: 1,
          provider: EMBEDDING_PROVIDER,
          model: this.config.EMBEDDING_MODEL,
        },
        maxAttempts: 3,
      });
      if (changed) created += 1;
    }
    return created;
  }

  async processBatch(workerId: string, limit = 20): Promise<EmbeddingSummary> {
    const summary: EmbeddingSummary = {
      jobsCreated: 0,
      jobsClaimed: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      embeddingsWritten: 0,
    };

    await this.processingJobs.releaseStaleRunningJobs(120);
    const jobs = await this.processingJobs.claimPendingJobs({
      workerId,
      types: [...EMBEDDING_JOB_TYPES],
      limit,
    });
    summary.jobsClaimed = jobs.length;

    for (const job of jobs) {
      try {
        const written = await this.processJob(job);
        await this.processingJobs.completeJob(job.id);
        summary.jobsCompleted += 1;
        summary.embeddingsWritten += written;
      } catch (error) {
        await this.processingJobs.failJob(job.id, error, this.nextRetryAt(job.attempts));
        summary.jobsFailed += 1;
      }
    }

    return summary;
  }

  async enqueueAndProcess(
    workerId: string,
    limit = 20,
    reindex = false,
  ): Promise<EmbeddingSummary> {
    const jobsCreated = await this.enqueueMissing(limit, reindex);
    const summary = await this.processBatch(workerId, limit);
    return { ...summary, jobsCreated };
  }

  async stats() {
    const result = await this.db.execute<{
      pending_count: string;
      running_count: string;
      completed_count: string;
      failed_count: string;
      embedding_count: string;
    }>(sql`
      select
        (select count(*) from processing_jobs where type = ${MESSAGE_EMBEDDING_JOB} and status = 'pending') as pending_count,
        (select count(*) from processing_jobs where type = ${MESSAGE_EMBEDDING_JOB} and status = 'running') as running_count,
        (select count(*) from processing_jobs where type = ${MESSAGE_EMBEDDING_JOB} and status = 'completed') as completed_count,
        (select count(*) from processing_jobs where type = ${MESSAGE_EMBEDDING_JOB} and status = 'failed') as failed_count,
        (select count(*) from embeddings where provider = ${EMBEDDING_PROVIDER} and model = ${this.config.EMBEDDING_MODEL}) as embedding_count
    `);
    return result.rows[0]!;
  }

  async semanticSearch(query: string, limit: number): Promise<SemanticSearchResult[]> {
    if (!query.trim()) return [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error("Semantic search limit must be between 1 and 20");
    }

    const embeddedQuery = await this.client.embedText(query);
    const queryVector = toPostgresDoubleArrayLiteral(embeddedQuery.embedding);
    const result = await this.db.execute<SemanticSearchResult>(sql`
      with query_embedding as (
        select ${queryVector}::double precision[] as vector
      ),
      scored as (
        select
          e.source_id,
          (
            select
              coalesce(sum(stored.value * query.value), 0)
              / nullif(
                sqrt(coalesce(sum(stored.value * stored.value), 0))
                * sqrt(coalesce(sum(query.value * query.value), 0)),
                0
              )
            from unnest(e.embedding) with ordinality as stored(value, ord)
            join unnest((select vector from query_embedding)) with ordinality as query(value, ord)
              on query.ord = stored.ord
          )::float as similarity
        from embeddings e
        where e.source_kind = 'message'
          and e.provider = ${EMBEDDING_PROVIDER}
          and e.model = ${this.config.EMBEDDING_MODEL}
          and e.dimensions = array_length((select vector from query_embedding), 1)
      )
      select
        m.id,
        m.telegram_chat_id as "telegramChatId",
        m.telegram_message_id as "telegramMessageId",
        m.telegram_date as "telegramDate",
        m.current_text as "currentText",
        m.message_type as "messageType",
        string_agg(a.original_file_name, ', ' order by a.original_file_name) as "attachmentNames",
        scored.similarity
      from scored
      join messages m on m.id = scored.source_id
      left join attachments a on a.message_id = m.id
      where scored.similarity is not null
      group by m.id, scored.similarity
      order by scored.similarity desc, m.telegram_date desc
      limit ${limit}
    `);
    return result.rows;
  }

  private async processJob(job: ProcessingJob) {
    if (job.type !== MESSAGE_EMBEDDING_JOB || job.subjectKind !== "message") {
      throw new Error(`Unsupported embedding job ${job.type}/${job.subjectKind}`);
    }

    const source = await buildMessageEmbeddingSourceText(
      this.db,
      job.subjectId,
      this.config.EMBEDDING_MAX_INPUT_CHARS,
    );
    if (!source) throw new Error(`Message not found for embedding: ${job.subjectId}`);
    if (!source.text) return 0;

    const existing = await this.db.execute<{ content_hash: string }>(sql`
      select content_hash
      from embeddings
      where source_kind = 'message'
        and source_id = ${job.subjectId}
        and provider = ${EMBEDDING_PROVIDER}
        and model = ${this.config.EMBEDDING_MODEL}
      limit 1
    `);
    if (existing.rows[0]?.content_hash === source.contentHash) {
      return 0;
    }

    const result = await this.client.embedText(source.text);
    await this.upsertEmbedding(job.subjectId, source.contentHash, result.embedding, {
      phase: 4,
      provider: EMBEDDING_PROVIDER,
      model: this.config.EMBEDDING_MODEL,
      returnedModel: result.model,
      processorVersion: 1,
      inputLength: source.text.length,
      inputParts: source.parts,
      rawAvailable: result.raw !== undefined,
    });
    await this.artifacts.upsert({
      sourceKind: "message",
      sourceId: job.subjectId,
      artifactType: "embedding_reference",
      artifactKey: `${EMBEDDING_PROVIDER}:${this.config.EMBEDDING_MODEL}`,
      content: {
        provider: EMBEDDING_PROVIDER,
        model: this.config.EMBEDDING_MODEL,
        dimensions: result.embedding.length,
        contentHash: source.contentHash,
      },
      metadata: {
        phase: 4,
        processor: "embedding_service",
        processorVersion: 1,
      },
    });
    return 1;
  }

  private async upsertEmbedding(
    messageId: string,
    contentHash: string,
    embedding: number[],
    metadata: Record<string, unknown>,
  ) {
    const vector = toPostgresDoubleArrayLiteral(embedding);
    await this.db.execute(sql`
      insert into embeddings (
        source_kind,
        source_id,
        provider,
        model,
        dimensions,
        content_hash,
        embedding,
        metadata,
        updated_at
      )
      values (
        'message',
        ${messageId},
        ${EMBEDDING_PROVIDER},
        ${this.config.EMBEDDING_MODEL},
        ${embedding.length},
        ${contentHash},
        ${vector}::double precision[],
        ${JSON.stringify(metadata)}::jsonb,
        now()
      )
      on conflict (source_kind, source_id, provider, model)
      do update set
        dimensions = excluded.dimensions,
        content_hash = excluded.content_hash,
        embedding = excluded.embedding,
        metadata = excluded.metadata,
        updated_at = now()
    `);
  }

  private async reopenExistingJobs(limit: number) {
    const result = await this.db.execute<{ id: string }>(sql`
      select messages.id
      from messages
      join processing_jobs job
        on job.type = ${MESSAGE_EMBEDDING_JOB}
        and job.subject_kind = 'message'
        and job.subject_id = messages.id
      where (
          coalesce(messages.current_text, '') <> ''
          or exists (
            select 1
            from attachments a
            join derived_artifacts da
              on da.source_kind = 'attachment'
              and da.source_id = a.id
              and da.artifact_type in ('ocr_text', 'transcript', 'image_description')
              and coalesce(da.content->>'text', '') <> ''
            where a.message_id = messages.id
          )
          or exists (
            select 1
            from attachments a
            where a.message_id = messages.id
              and a.original_file_name is not null
          )
        )
        and job.status in ('completed', 'failed')
      order by messages.telegram_date asc, messages.created_at asc
      limit ${limit}
    `);
    if (result.rows.length === 0) return;

    await this.db.execute(sql`
      update processing_jobs
      set
        status = 'pending',
        attempts = 0,
        locked_by = null,
        locked_at = null,
        last_error = null,
        run_after = now(),
        completed_at = null,
        updated_at = now()
      where type = ${MESSAGE_EMBEDDING_JOB}
        and subject_kind = 'message'
        and subject_id in (${sql.join(
          result.rows.map((row) => sql`${row.id}`),
          sql`, `,
        )})
    `);
  }

  private nextRetryAt(attempts: number) {
    const delayMinutes = Math.min(24 * 60, 5 * 2 ** Math.max(0, attempts - 1));
    return new Date(Date.now() + delayMinutes * 60_000);
  }
}

function toPostgresDoubleArrayLiteral(values: number[]) {
  if (values.length === 0) {
    throw new Error("Embedding vector cannot be empty");
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error("Embedding vector contains a non-finite value");
    }
  }
  return `{${values.join(",")}}`;
}
