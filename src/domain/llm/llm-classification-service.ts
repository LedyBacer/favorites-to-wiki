import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { ProcessingJob } from "../../db/schema.js";
import { ProcessingJobService } from "../processing/processing-job-service.js";
import { DerivedArtifactService } from "../preprocessing/derived-artifact-service.js";
import { buildClassificationSource, type ClassificationSource } from "./classification-source.js";
import { OllamaChatClient } from "./ollama-chat-client.js";
import { CLASSIFICATION_SYSTEM_PROMPT, classificationUserPrompt } from "./prompts.js";
import {
  classificationJsonSchema,
  classificationOutputSchema,
  type ClassificationOutput,
} from "./schemas.js";

export const LLM_CLASSIFICATION_JOB = "llm_classification";
export const LLM_CLASSIFICATION_JOB_TYPES = [LLM_CLASSIFICATION_JOB] as const;
export const LLM_PROVIDER = "ollama";
export const LLM_CLASSIFICATION_PROCESSOR_VERSION = 3;

export interface LlmClassificationSummary {
  jobsCreated: number;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  recordsWritten: number;
  entitiesWritten: number;
  relationsWritten: number;
  artifactsWritten: number;
}

export class LlmClassificationService {
  private readonly processingJobs: ProcessingJobService;
  private readonly artifacts: DerivedArtifactService;
  private readonly client: OllamaChatClient;

  constructor(
    private readonly db: Database,
    private readonly config: Pick<
      AppConfig,
      | "LLM_SERVICE_URL"
      | "LLM_SERVICE_API_KEY"
      | "LLM_MODEL"
      | "LLM_SERVICE_TIMEOUT_MS"
      | "LLM_MAX_INPUT_CHARS"
    >,
  ) {
    this.processingJobs = new ProcessingJobService(db);
    this.artifacts = new DerivedArtifactService(db);
    this.client = new OllamaChatClient({
      baseUrl: config.LLM_SERVICE_URL,
      apiKey: config.LLM_SERVICE_API_KEY,
      timeoutMs: config.LLM_SERVICE_TIMEOUT_MS,
    });
  }

  async enqueueMissing(limit = 100, reclassify = false): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error("Classification enqueue limit must be between 1 and 5000");
    }

    if (reclassify) {
      await this.reopenExistingJobs(limit);
    }

    const generationKey = this.generationKey();
    const artifactKey = this.artifactKey();
    const bundleRows = await this.db.execute<{ id: string }>(sql`
      select b.id
      from bundles b
      where b.metadata->>'createdBy' = 'auto_bundle_service'
        and b.status = 'closed'
        and not exists (
          select 1
          from processing_jobs job
          join derived_artifacts da
            on da.source_kind = 'bundle'
            and da.source_id = b.id
            and da.artifact_type = 'llm_classification'
            and da.artifact_key = ${artifactKey}
          where job.type = ${LLM_CLASSIFICATION_JOB}
            and job.subject_kind = 'bundle'
            and job.subject_id = b.id
            and job.generation_key = ${generationKey}
            and job.status = 'completed'
            and job.input_hash = da.content->>'sourceContentHash'
        )
      order by b.created_at asc
      limit ${limit}
    `);

    let created = 0;
    for (const row of bundleRows.rows) {
      const source = await buildClassificationSource(
        this.db,
        row.id,
        this.config.LLM_MAX_INPUT_CHARS,
        "bundle",
      );
      if (!source?.text) continue;
      const changed = await this.processingJobs.enqueueOrRefresh({
        type: LLM_CLASSIFICATION_JOB,
        subjectKind: "bundle",
        subjectId: row.id,
        generationKey,
        inputHash: source.contentHash,
        payload: {
          phase: 7,
          processorVersion: LLM_CLASSIFICATION_PROCESSOR_VERSION,
          provider: LLM_PROVIDER,
          model: this.config.LLM_MODEL,
          sourceKind: "bundle",
        },
        maxAttempts: 3,
      });
      if (changed) created += 1;
    }

    const remaining = Math.max(0, limit - bundleRows.rows.length);
    if (remaining === 0) return created;

    const result = await this.db.execute<{ id: string }>(sql`
      select messages.id
      from messages
      where not exists (
          select 1
          from bundle_messages bm
          join bundles b on b.id = bm.bundle_id
          where bm.message_id = messages.id
            and b.metadata->>'createdBy' = 'auto_bundle_service'
        )
        and (
          coalesce(messages.current_text, '') <> ''
          or exists (
            select 1
            from attachments a
            where a.message_id = messages.id
              and a.original_file_name is not null
          )
          or exists (
            select 1
            from attachments a
            join derived_artifacts da
              on da.source_kind = 'attachment'
              and da.source_id = a.id
              and da.artifact_type in ('ocr_text', 'transcript', 'image_description')
            where a.message_id = messages.id
          )
        )
        and not exists (
          select 1
          from processing_jobs job
          join derived_artifacts da
            on da.source_kind = 'message'
            and da.source_id = messages.id
            and da.artifact_type = 'llm_classification'
            and da.artifact_key = ${artifactKey}
          where job.type = ${LLM_CLASSIFICATION_JOB}
            and job.subject_kind = 'message'
            and job.subject_id = messages.id
            and job.generation_key = ${generationKey}
            and job.status = 'completed'
            and job.input_hash = da.content->>'sourceContentHash'
        )
      order by messages.telegram_date asc, messages.created_at asc
      limit ${remaining}
    `);
    for (const row of result.rows) {
      const source = await buildClassificationSource(
        this.db,
        row.id,
        this.config.LLM_MAX_INPUT_CHARS,
        "message",
      );
      if (!source?.text) continue;
      const changed = await this.processingJobs.enqueueOrRefresh({
        type: LLM_CLASSIFICATION_JOB,
        subjectKind: "message",
        subjectId: row.id,
        generationKey,
        inputHash: source.contentHash,
        payload: {
          phase: 7,
          processorVersion: LLM_CLASSIFICATION_PROCESSOR_VERSION,
          provider: LLM_PROVIDER,
          model: this.config.LLM_MODEL,
          sourceKind: "message",
        },
        maxAttempts: 3,
      });
      if (changed) created += 1;
    }
    return created;
  }

  async processBatch(workerId: string, limit = 20): Promise<LlmClassificationSummary> {
    const summary = emptySummary();
    await this.processingJobs.releaseStaleRunningJobs(120);
    const jobs = await this.processingJobs.claimPendingJobs({
      workerId,
      types: [...LLM_CLASSIFICATION_JOB_TYPES],
      limit,
    });
    summary.jobsClaimed = jobs.length;

    for (const job of jobs) {
      try {
        const written = await this.processJob(job);
        await this.processingJobs.completeJob(job.id);
        summary.jobsCompleted += 1;
        summary.recordsWritten += written.records;
        summary.entitiesWritten += written.entities;
        summary.relationsWritten += written.relations;
        summary.artifactsWritten += written.artifacts;
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
    reclassify = false,
  ): Promise<LlmClassificationSummary> {
    const jobsCreated = await this.enqueueMissing(limit, reclassify);
    const summary = await this.processBatch(workerId, limit);
    return { ...summary, jobsCreated };
  }

  async stats() {
    const result = await this.db.execute<{
      pending_count: string;
      running_count: string;
      completed_count: string;
      failed_count: string;
      record_count: string;
      entity_count: string;
      relation_count: string;
    }>(sql`
      select
        (select count(*) from processing_jobs where type = ${LLM_CLASSIFICATION_JOB} and status = 'pending') as pending_count,
        (select count(*) from processing_jobs where type = ${LLM_CLASSIFICATION_JOB} and status = 'running') as running_count,
        (select count(*) from processing_jobs where type = ${LLM_CLASSIFICATION_JOB} and status = 'completed') as completed_count,
        (select count(*) from processing_jobs where type = ${LLM_CLASSIFICATION_JOB} and status = 'failed') as failed_count,
        (select count(*) from records where status = 'proposed') as record_count,
        (select count(*) from entities where status = 'proposed') as entity_count,
        (select count(*) from relations where status = 'proposed') as relation_count
    `);
    return result.rows[0]!;
  }

  async recentProposals(limit = 5) {
    const safeLimit = Math.min(Math.max(limit, 1), 20);
    const result = await this.db.execute<{
      id: string;
      type: string;
      title: string | null;
      body: string | null;
      source_message_id: string | null;
      created_at: Date | string;
    }>(sql`
      select id, type, title, body, source_message_id, created_at
      from records
      where status = 'proposed'
      order by updated_at desc, created_at desc
      limit ${safeLimit}
    `);
    return result.rows;
  }

  private async processJob(job: ProcessingJob) {
    if (
      job.type !== LLM_CLASSIFICATION_JOB ||
      (job.subjectKind !== "message" && job.subjectKind !== "bundle")
    ) {
      throw new Error(`Unsupported classification job ${job.type}/${job.subjectKind}`);
    }

    const source = await buildClassificationSource(
      this.db,
      job.subjectId,
      this.config.LLM_MAX_INPUT_CHARS,
      job.subjectKind,
    );
    if (!source) throw new Error(`Source not found for classification: ${job.subjectId}`);
    if (!source.text) return { records: 0, entities: 0, relations: 0, artifacts: 0 };

    const result = await this.client.chatJson({
      model: this.config.LLM_MODEL,
      schema: classificationJsonSchema,
      responseSchema: classificationOutputSchema,
      messages: [
        { role: "system", content: CLASSIFICATION_SYSTEM_PROMPT },
        { role: "user", content: classificationUserPrompt(source.text) },
      ],
    });

    await this.artifacts.upsert({
      sourceKind: source.sourceKind,
      sourceId: job.subjectId,
      artifactType: "llm_classification",
      artifactKey: `${LLM_PROVIDER}:${this.config.LLM_MODEL}`,
      content: {
        provider: LLM_PROVIDER,
        model: this.config.LLM_MODEL,
        returnedModel: result.model,
        sourceContentHash: source.contentHash,
        output: result.value,
      },
      metadata: {
        phase: 7,
        processor: "llm_classification_service",
        processorVersion: LLM_CLASSIFICATION_PROCESSOR_VERSION,
        inputParts: source.parts,
        rawAvailable: result.raw !== undefined,
      },
    });

    const written = await this.persistProposal(source, result.value);
    return { ...written, artifacts: 1 };
  }

  private async persistProposal(source: ClassificationSource, output: ClassificationOutput) {
    const recordIds: string[] = [];
    const modelKey = `${LLM_PROVIDER}:${this.config.LLM_MODEL}`;
    const generationKey = this.generationKey();
    const baseMetadata = {
      status: "proposed",
      phase: 7,
      provider: LLM_PROVIDER,
      model: this.config.LLM_MODEL,
      generationKey,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      sourceContentHash: source.contentHash,
      summary: output.summary,
      intent: output.intent,
      confidence: output.confidence,
      needsClarification: output.needsClarification,
      clarificationQuestion: output.needsClarification ? output.clarificationQuestion : null,
      retention: output.retention,
    };

    for (const [index, record] of output.records.entries()) {
      const proposalKey = proposalKeyFor(
        "record",
        source.sourceId,
        modelKey,
        `${generationKey}:${index}`,
      );
      const result = await this.db.execute<{ id: string }>(sql`
        insert into records (proposal_key, type, title, body, status, source_message_id, source_bundle_id, metadata, updated_at)
        values (
          ${proposalKey},
          ${record.type}::record_type,
          ${record.title},
          ${record.body},
          'proposed',
          ${source.messageId},
          ${source.sourceKind === "bundle" ? source.sourceId : null},
          ${JSON.stringify({ ...baseMetadata, confidence: record.confidence, tags: record.tags })}::jsonb,
          now()
        )
        on conflict (proposal_key)
        do update set
          type = excluded.type,
          title = excluded.title,
          body = excluded.body,
          status = case when records.status = 'proposed' then excluded.status else records.status end,
          source_message_id = excluded.source_message_id,
          source_bundle_id = excluded.source_bundle_id,
          metadata = case when records.status = 'proposed' then excluded.metadata else records.metadata end,
          updated_at = now()
        where records.status = 'proposed'
        returning id
      `);
      if (result.rows[0]) recordIds.push(result.rows[0].id);
    }

    const entityByName = new Map<string, string>();
    for (const entity of output.entities) {
      const normalizedName = entity.name.trim().toLowerCase();
      if (!normalizedName) continue;
      const proposalKey = proposalKeyFor(
        "entity",
        source.sourceId,
        modelKey,
        `${generationKey}:${entity.type}:${normalizedName}`,
      );
      const result = await this.db.execute<{ id: string }>(sql`
        insert into entities (proposal_key, type, name, status, metadata)
        values (
          ${proposalKey},
          ${entity.type},
          ${entity.name},
          'proposed',
          ${JSON.stringify({ ...baseMetadata, confidence: entity.confidence })}::jsonb
        )
        on conflict (proposal_key)
        do update set
          type = excluded.type,
          name = excluded.name,
          status = case when entities.status = 'proposed' then excluded.status else entities.status end,
          metadata = case when entities.status = 'proposed' then excluded.metadata else entities.metadata end
        where entities.status = 'proposed'
        returning id
      `);
      if (result.rows[0]) entityByName.set(normalizedName, result.rows[0].id);
    }

    let relationsWritten = 0;
    for (const relation of output.relations) {
      const recordId = recordIds[relation.fromRecordIndex];
      const entityId = entityByName.get(relation.toEntityName.trim().toLowerCase());
      if (!recordId || !entityId) continue;
      const proposalKey = proposalKeyFor(
        "relation",
        source.sourceId,
        modelKey,
        `${generationKey}:${relation.fromRecordIndex}:${relation.type}:${relation.toEntityName}`,
      );
      await this.db.execute(sql`
        insert into relations (proposal_key, from_kind, from_id, to_kind, to_id, type, status, metadata)
        values (
          ${proposalKey},
          'record',
          ${recordId},
          'entity',
          ${entityId},
          ${relation.type},
          'proposed',
          ${JSON.stringify({ ...baseMetadata, confidence: relation.confidence })}::jsonb
        )
        on conflict (proposal_key)
        do update set
          from_kind = excluded.from_kind,
          from_id = excluded.from_id,
          to_kind = excluded.to_kind,
          to_id = excluded.to_id,
          type = excluded.type,
          status = case when relations.status = 'proposed' then excluded.status else relations.status end,
          metadata = case when relations.status = 'proposed' then excluded.metadata else relations.metadata end
        where relations.status = 'proposed'
      `);
      relationsWritten += 1;
    }

    await this.supersedeMissingProposals(source, generationKey, recordIds, [...entityByName.values()]);
    await this.syncClarificationRequest(source, output, generationKey);

    return {
      records: recordIds.length,
      entities: entityByName.size,
      relations: relationsWritten,
    };
  }

  private async reopenExistingJobs(limit: number) {
    const result = await this.db.execute<{ id: string }>(sql`
      select job.subject_id as id
      from processing_jobs job
      left join messages on messages.id = job.subject_id and job.subject_kind = 'message'
      left join bundles on bundles.id = job.subject_id and job.subject_kind = 'bundle'
      where job.status in ('completed', 'failed')
        and job.type = ${LLM_CLASSIFICATION_JOB}
        and job.subject_kind in ('message', 'bundle')
      order by coalesce(messages.telegram_date, bundles.created_at) asc
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
      where type = ${LLM_CLASSIFICATION_JOB}
        and subject_kind in ('message', 'bundle')
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

  private generationKey() {
    return `phase7:${LLM_PROVIDER}:${this.config.LLM_MODEL}:classification:v${LLM_CLASSIFICATION_PROCESSOR_VERSION}`;
  }

  private artifactKey() {
    return `${LLM_PROVIDER}:${this.config.LLM_MODEL}`;
  }

  private async supersedeMissingProposals(
    source: ClassificationSource,
    generationKey: string,
    activeRecordIds: string[],
    activeEntityIds: string[],
  ) {
    const sourceFilter = sql`
      metadata->>'sourceKind' = ${source.sourceKind}
      and metadata->>'sourceId' = ${source.sourceId}
      and metadata->>'provider' = ${LLM_PROVIDER}
      and metadata->>'model' = ${this.config.LLM_MODEL}
      and metadata->>'generationKey' = ${generationKey}
      and status = 'proposed'
    `;
    if (activeRecordIds.length > 0) {
      await this.db.execute(sql`
        update records
        set status = 'superseded',
            metadata = metadata || jsonb_build_object('status', 'superseded', 'supersededAt', now()),
            updated_at = now()
        where ${sourceFilter}
          and not (id in (${sql.join(activeRecordIds.map((id) => sql`${id}`), sql`, `)}))
      `);
    } else {
      await this.db.execute(sql`
        update records
        set status = 'superseded',
            metadata = metadata || jsonb_build_object('status', 'superseded', 'supersededAt', now()),
            updated_at = now()
        where ${sourceFilter}
      `);
    }

    if (activeEntityIds.length > 0) {
      await this.db.execute(sql`
        update entities
        set status = 'superseded',
            metadata = metadata || jsonb_build_object('status', 'superseded', 'supersededAt', now())
        where ${sourceFilter}
          and not (id in (${sql.join(activeEntityIds.map((id) => sql`${id}`), sql`, `)}))
      `);
    } else {
      await this.db.execute(sql`
        update entities
        set status = 'superseded',
            metadata = metadata || jsonb_build_object('status', 'superseded', 'supersededAt', now())
        where ${sourceFilter}
      `);
    }

    await this.db.execute(sql`
      update relations
      set status = 'superseded',
          metadata = metadata || jsonb_build_object('status', 'superseded', 'supersededAt', now())
      where ${sourceFilter}
        and (
          from_id not in (select id from records where status = 'proposed')
          or to_id not in (select id from entities where status = 'proposed')
        )
    `);
  }

  private async syncClarificationRequest(
    source: ClassificationSource,
    output: ClassificationOutput,
    generationKey: string,
  ) {
    if (!output.needsClarification || !output.clarificationQuestion?.trim()) {
      await this.db.execute(sql`
        update clarification_requests
        set status = 'superseded',
            updated_at = now()
        where source_kind = ${source.sourceKind}
          and source_id = ${source.sourceId}
          and provider = ${LLM_PROVIDER}
          and model = ${this.config.LLM_MODEL}
          and generation_key = ${generationKey}
          and status = 'pending'
      `);
      return;
    }

    const question = output.clarificationQuestion.trim();
    const questionHash = createHash("sha256").update(question.toLowerCase()).digest("hex");
    await this.db.execute(sql`
      update clarification_requests
      set question = ${question},
          question_hash = ${questionHash},
          metadata = metadata || ${JSON.stringify({ sourceContentHash: source.contentHash })}::jsonb,
          updated_at = now()
      where source_kind = ${source.sourceKind}
        and source_id = ${source.sourceId}
        and status = 'pending'
        and question_hash is distinct from ${questionHash}
    `);

    await this.db.execute(sql`
      insert into clarification_requests (
        source_kind,
        source_id,
        provider,
        model,
        generation_key,
        question,
        question_hash,
        status,
        metadata,
        updated_at
      )
      select
        ${source.sourceKind},
        ${source.sourceId},
        ${LLM_PROVIDER},
        ${this.config.LLM_MODEL},
        ${generationKey},
        ${question},
        ${questionHash},
        'pending',
        ${JSON.stringify({ sourceContentHash: source.contentHash })}::jsonb,
        now()
      where not exists (
          select 1
          from clarification_requests
          where source_kind = ${source.sourceKind}
            and source_id = ${source.sourceId}
            and status = 'pending'
        )
        and not exists (
          select 1
          from clarification_requests
          where source_kind = ${source.sourceKind}
            and source_id = ${source.sourceId}
            and provider = ${LLM_PROVIDER}
            and model = ${this.config.LLM_MODEL}
            and generation_key = ${generationKey}
            and question_hash = ${questionHash}
        )
    `);
  }
}

function emptySummary(): LlmClassificationSummary {
  return {
    jobsCreated: 0,
    jobsClaimed: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    recordsWritten: 0,
    entitiesWritten: 0,
    relationsWritten: 0,
    artifactsWritten: 0,
  };
}

function proposalKeyFor(kind: string, messageId: string, modelKey: string, value: string) {
  const hash = createHash("sha256")
    .update(`${kind}:${messageId}:${modelKey}:${value}`)
    .digest("hex");
  return `llm:${kind}:${hash}`;
}
