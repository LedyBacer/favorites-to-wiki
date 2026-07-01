import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { Attachment, ProcessingJob } from "../../db/schema.js";
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

    const messageJobs = await this.db.execute<{ id: string }>(sql`
      insert into processing_jobs (type, subject_kind, subject_id, payload)
      select
        ${MESSAGE_PREPROCESSING_JOB},
        'message',
        messages.id,
        jsonb_build_object('phase', 2, 'processorVersion', 1)
      from messages
      where not exists (
        select 1
        from processing_jobs existing
        where existing.type = ${MESSAGE_PREPROCESSING_JOB}
          and existing.subject_kind = 'message'
          and existing.subject_id = messages.id
      )
      order by messages.telegram_date asc, messages.created_at asc
      limit ${limit}
      on conflict (type, subject_kind, subject_id) do nothing
      returning id
    `);

    const remaining = Math.max(0, limit - messageJobs.rows.length);
    if (remaining === 0) return messageJobs.rows.length;

    const attachmentJobs = await this.db.execute<{ id: string }>(sql`
      insert into processing_jobs (type, subject_kind, subject_id, payload)
      select
        ${ATTACHMENT_PREPROCESSING_JOB},
        'attachment',
        attachments.id,
        jsonb_build_object('phase', 2, 'processorVersion', 1)
      from attachments
      where not exists (
        select 1
        from processing_jobs existing
        where existing.type = ${ATTACHMENT_PREPROCESSING_JOB}
          and existing.subject_kind = 'attachment'
          and existing.subject_id = attachments.id
      )
      order by attachments.created_at asc
      limit ${remaining}
      on conflict (type, subject_kind, subject_id) do nothing
      returning id
    `);

    return messageJobs.rows.length + attachmentJobs.rows.length;
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
