import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { Attachment, ProcessingJob } from "../../db/schema.js";
import { hashProcessingInput } from "../processing/hash.js";
import { ProcessingJobService } from "../processing/processing-job-service.js";
import { DerivedArtifactService } from "./derived-artifact-service.js";
import {
  buildFileMetadata,
  buildFilePreview,
  buildLinkPreview,
  extractMessageMetadata,
  messagePreprocessingSource,
  normalizeText,
} from "./extract.js";

export const MESSAGE_PREPROCESSING_JOB = "deterministic_message_preprocess";
export const ATTACHMENT_PREPROCESSING_JOB = "deterministic_attachment_preprocess";
export const PREPROCESSING_JOB_TYPES = [
  MESSAGE_PREPROCESSING_JOB,
  ATTACHMENT_PREPROCESSING_JOB,
] as const;

export interface PreprocessingSummary {
  jobsCreated: number;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  artifactsWritten: number;
}

export class PreprocessingService {
  private readonly processingJobs: ProcessingJobService;
  private readonly artifacts: DerivedArtifactService;

  constructor(private readonly db: Database) {
    this.processingJobs = new ProcessingJobService(db);
    this.artifacts = new DerivedArtifactService(db);
  }

  async enqueueMissing(limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error("Preprocessing enqueue limit must be between 1 and 5000");
    }

    const messageRows = await this.db.execute<{
      id: string;
      current_text: string | null;
      metadata: unknown;
      updated_at: Date | string;
    }>(sql`
      select
        messages.id,
        messages.current_text,
        messages.metadata,
        messages.updated_at
      from messages
      order by messages.telegram_date asc, messages.created_at asc
      limit ${limit}
    `);
    let created = 0;
    for (const row of messageRows.rows) {
      const changed = await this.processingJobs.enqueueOrRefresh({
        type: MESSAGE_PREPROCESSING_JOB,
        subjectKind: "message",
        subjectId: row.id,
        generationKey: "phase2:v1",
        inputHash: hashProcessingInput({
          text: row.current_text,
          metadata: row.metadata,
          updatedAt: row.updated_at,
        }),
        payload: { phase: 2, processorVersion: 1 },
      });
      if (changed) created += 1;
    }

    const remaining = Math.max(0, limit - created);
    if (remaining === 0) return created;

    const attachmentRows = await this.db.execute<{
      id: string;
      original_file_name: string | null;
      mime_type: string | null;
      size_bytes: number | null;
      local_path: string | null;
      sha256: string | null;
      download_status: string;
    }>(sql`
      select
        attachments.id,
        attachments.original_file_name,
        attachments.mime_type,
        attachments.size_bytes,
        attachments.local_path,
        attachments.sha256,
        attachments.download_status
      from attachments
      order by attachments.created_at asc
      limit ${remaining}
    `);
    for (const row of attachmentRows.rows) {
      const changed = await this.processingJobs.enqueueOrRefresh({
        type: ATTACHMENT_PREPROCESSING_JOB,
        subjectKind: "attachment",
        subjectId: row.id,
        generationKey: "phase2:v1",
        inputHash: hashProcessingInput(row),
        payload: { phase: 2, processorVersion: 1 },
      });
      if (changed) created += 1;
    }

    return created;
  }

  async processBatch(workerId: string, limit = 50): Promise<PreprocessingSummary> {
    const summary: PreprocessingSummary = {
      jobsCreated: 0,
      jobsClaimed: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      artifactsWritten: 0,
    };

    await this.processingJobs.releaseStaleRunningJobs(30);
    const jobs = await this.processingJobs.claimPendingJobs({
      workerId,
      types: [...PREPROCESSING_JOB_TYPES],
      limit,
    });
    summary.jobsClaimed = jobs.length;

    for (const job of jobs) {
      try {
        const artifactsWritten = await this.processJob(job);
        await this.processingJobs.completeJob(job.id);
        summary.jobsCompleted += 1;
        summary.artifactsWritten += artifactsWritten;
      } catch (error) {
        await this.processingJobs.failJob(job.id, error, this.nextRetryAt(job.attempts));
        summary.jobsFailed += 1;
      }
    }

    return summary;
  }

  async enqueueAndProcess(workerId: string, limit = 50): Promise<PreprocessingSummary> {
    const jobsCreated = await this.enqueueMissing(limit);
    const summary = await this.processBatch(workerId, limit);
    return { ...summary, jobsCreated };
  }

  async stats() {
    const jobTypes = sql.join(
      PREPROCESSING_JOB_TYPES.map((type) => sql`${type}`),
      sql`, `,
    );
    const result = await this.db.execute<{
      pending_count: string;
      running_count: string;
      completed_count: string;
      failed_count: string;
      artifact_count: string;
    }>(sql`
      select
        (select count(*) from processing_jobs where type in (${jobTypes}) and status = 'pending') as pending_count,
        (select count(*) from processing_jobs where type in (${jobTypes}) and status = 'running') as running_count,
        (select count(*) from processing_jobs where type in (${jobTypes}) and status = 'completed') as completed_count,
        (select count(*) from processing_jobs where type in (${jobTypes}) and status = 'failed') as failed_count,
        (select count(*) from derived_artifacts where artifact_type in ('normalized_text', 'extracted_metadata', 'file_metadata', 'link_preview', 'file_preview')) as artifact_count
    `);
    return result.rows[0]!;
  }

  private async processJob(job: ProcessingJob) {
    if (job.type === MESSAGE_PREPROCESSING_JOB && job.subjectKind === "message") {
      return this.processMessage(job.subjectId);
    }
    if (job.type === ATTACHMENT_PREPROCESSING_JOB && job.subjectKind === "attachment") {
      return this.processAttachment(job.subjectId);
    }
    throw new Error(`Unsupported preprocessing job ${job.type}/${job.subjectKind}`);
  }

  private async processMessage(messageId: string) {
    const message = await this.db.query.messages.findFirst({
      where: (table, { eq }) => eq(table.id, messageId),
    });
    if (!message) throw new Error(`Message not found for preprocessing: ${messageId}`);

    const source = messagePreprocessingSource(message);
    const normalized = normalizeText(message.currentText);
    const extracted = extractMessageMetadata(message.currentText);
    const linkPreview = buildLinkPreview(extracted);
    const metadata = this.artifactMetadata(source);

    await this.artifacts.upsert({
      sourceKind: "message",
      sourceId: message.id,
      artifactType: "normalized_text",
      content: normalized,
      metadata,
    });
    await this.artifacts.upsert({
      sourceKind: "message",
      sourceId: message.id,
      artifactType: "extracted_metadata",
      content: extracted,
      metadata,
    });
    await this.artifacts.upsert({
      sourceKind: "message",
      sourceId: message.id,
      artifactType: "link_preview",
      content: linkPreview,
      metadata: { ...metadata, fetched: false, reason: "network_fetch_disabled" },
    });
    return 3;
  }

  private async processAttachment(attachmentId: string) {
    const attachment = await this.db.query.attachments.findFirst({
      where: (table, { eq }) => eq(table.id, attachmentId),
    });
    if (!attachment) throw new Error(`Attachment not found for preprocessing: ${attachmentId}`);

    const fileMetadata = buildFileMetadata(attachment);
    const filePreview = buildFilePreview(fileMetadata);
    const metadata = this.attachmentArtifactMetadata(attachment);

    await this.artifacts.upsert({
      sourceKind: "attachment",
      sourceId: attachment.id,
      artifactType: "file_metadata",
      content: fileMetadata,
      metadata,
    });
    await this.artifacts.upsert({
      sourceKind: "attachment",
      sourceId: attachment.id,
      artifactType: "file_preview",
      content: filePreview,
      metadata,
    });
    return 2;
  }

  private artifactMetadata(source: ReturnType<typeof messagePreprocessingSource>) {
    return {
      phase: 2,
      processor: "deterministic_preprocessing",
      processorVersion: 1,
      source,
    };
  }

  private attachmentArtifactMetadata(attachment: Attachment) {
    return {
      phase: 2,
      processor: "deterministic_preprocessing",
      processorVersion: 1,
      source: {
        attachmentId: attachment.id,
        messageId: attachment.messageId,
        downloadStatus: attachment.downloadStatus,
        createdAt: attachment.createdAt,
      },
    };
  }

  private nextRetryAt(attempts: number) {
    const delayMinutes = Math.min(24 * 60, 2 ** Math.max(0, attempts - 1));
    return new Date(Date.now() + delayMinutes * 60_000);
  }
}
