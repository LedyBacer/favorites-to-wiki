import { sql } from "drizzle-orm";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { Attachment, ProcessingJob } from "../../db/schema.js";
import { hashProcessingInput } from "../processing/hash.js";
import { ProcessingJobService } from "../processing/processing-job-service.js";
import { DerivedArtifactService } from "../preprocessing/derived-artifact-service.js";
import { isAsrCandidate, isOcrCandidate } from "./media-kind.js";
import { MediaProcessorClient } from "./processor-client.js";

export const OCR_PROCESSING_JOB = "media_ocr";
export const ASR_PROCESSING_JOB = "media_asr";
export const MEDIA_PROCESSING_JOB_TYPES = [OCR_PROCESSING_JOB, ASR_PROCESSING_JOB] as const;
export type MediaProcessingMode = "all" | "ocr" | "asr";

export interface MediaProcessingSummary {
  jobsCreated: number;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  artifactsWritten: number;
}

export class MediaProcessingService {
  private readonly processingJobs: ProcessingJobService;
  private readonly artifacts: DerivedArtifactService;
  private readonly ocrClient: MediaProcessorClient;
  private readonly asrClient: MediaProcessorClient;

  constructor(
    private readonly db: Database,
    private readonly config: Pick<
      AppConfig,
      | "STORAGE_ROOT"
      | "OCR_SERVICE_URL"
      | "OCR_SERVICE_API_KEY"
      | "OCR_SERVICE_TIMEOUT_MS"
      | "OCR_MAX_ATTACHMENT_BYTES"
      | "ASR_SERVICE_URL"
      | "ASR_SERVICE_API_KEY"
      | "ASR_SERVICE_TIMEOUT_MS"
      | "ASR_MAX_ATTACHMENT_BYTES"
    >,
  ) {
    this.processingJobs = new ProcessingJobService(db);
    this.artifacts = new DerivedArtifactService(db);
    this.ocrClient = new MediaProcessorClient({
      baseUrl: config.OCR_SERVICE_URL,
      apiKey: config.OCR_SERVICE_API_KEY,
      timeoutMs: config.OCR_SERVICE_TIMEOUT_MS,
      storageRoot: config.STORAGE_ROOT,
      maxBytes: config.OCR_MAX_ATTACHMENT_BYTES,
    });
    this.asrClient = new MediaProcessorClient({
      baseUrl: config.ASR_SERVICE_URL,
      apiKey: config.ASR_SERVICE_API_KEY,
      timeoutMs: config.ASR_SERVICE_TIMEOUT_MS,
      storageRoot: config.STORAGE_ROOT,
      maxBytes: config.ASR_MAX_ATTACHMENT_BYTES,
    });
  }

  async enqueueMissing(limit = 100, mode: MediaProcessingMode = "all"): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error("Media processing enqueue limit must be between 1 and 5000");
    }

    let created = 0;
    if (mode === "all" || mode === "ocr") {
      created += await this.enqueueOcr(limit - created);
    }
    if (created < limit && (mode === "all" || mode === "asr")) {
      created += await this.enqueueAsr(limit - created);
    }
    return created;
  }

  async processBatch(workerId: string, limit = 20): Promise<MediaProcessingSummary> {
    const summary: MediaProcessingSummary = {
      jobsCreated: 0,
      jobsClaimed: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      artifactsWritten: 0,
    };

    await this.processingJobs.releaseStaleRunningJobs(120);
    const jobs = await this.processingJobs.claimPendingJobs({
      workerId,
      types: [...MEDIA_PROCESSING_JOB_TYPES],
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

  async enqueueAndProcess(
    workerId: string,
    limit = 20,
    mode: MediaProcessingMode = "all",
  ): Promise<MediaProcessingSummary> {
    const jobsCreated = await this.enqueueMissing(limit, mode);
    const summary = await this.processBatch(workerId, limit);
    return { ...summary, jobsCreated };
  }

  async stats() {
    const jobTypes = sql.join(
      MEDIA_PROCESSING_JOB_TYPES.map((type) => sql`${type}`),
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
        (select count(*) from derived_artifacts where artifact_type in ('ocr_text', 'transcript')) as artifact_count
    `);
    return result.rows[0]!;
  }

  private async enqueueOcr(limit: number) {
    if (limit < 1) return 0;
    const result = await this.db.execute<{
      id: string;
      local_path: string | null;
      sha256: string | null;
      mime_type: string | null;
      size_bytes: number | null;
    }>(sql`
      select
        attachments.id,
        attachments.local_path,
        attachments.sha256,
        attachments.mime_type,
        attachments.size_bytes
      from attachments
      where attachments.download_status = 'downloaded'
        and attachments.local_path is not null
        and (
          lower(coalesce(attachments.mime_type, '')) like 'image/%'
          or lower(coalesce(attachments.original_file_name, attachments.local_path, '')) ~ '\\.(bmp|gif|jpe?g|png|tiff?|webp)$'
        )
      order by attachments.created_at asc
      limit ${limit}
    `);
    let created = 0;
    for (const row of result.rows) {
      const changed = await this.processingJobs.enqueueOrRefresh({
        type: OCR_PROCESSING_JOB,
        subjectKind: "attachment",
        subjectId: row.id,
        generationKey: "phase3:ocr:v1",
        inputHash: hashProcessingInput(row),
        payload: { phase: 3, processorVersion: 1, artifactType: "ocr_text" },
        maxAttempts: 3,
      });
      if (changed) created += 1;
    }
    return created;
  }

  private async enqueueAsr(limit: number) {
    if (limit < 1) return 0;
    const result = await this.db.execute<{
      id: string;
      local_path: string | null;
      sha256: string | null;
      mime_type: string | null;
      size_bytes: number | null;
    }>(sql`
      select
        attachments.id,
        attachments.local_path,
        attachments.sha256,
        attachments.mime_type,
        attachments.size_bytes
      from attachments
      where attachments.download_status = 'downloaded'
        and attachments.local_path is not null
        and (
          lower(coalesce(attachments.mime_type, '')) like 'audio/%'
          or lower(coalesce(attachments.mime_type, '')) like 'video/%'
          or lower(coalesce(attachments.original_file_name, attachments.local_path, '')) ~ '\\.(aac|flac|m4a|mkv|mov|mp3|mp4|mpeg|oga|ogg|opus|wav|webm)$'
        )
      order by attachments.created_at asc
      limit ${limit}
    `);
    let created = 0;
    for (const row of result.rows) {
      const changed = await this.processingJobs.enqueueOrRefresh({
        type: ASR_PROCESSING_JOB,
        subjectKind: "attachment",
        subjectId: row.id,
        generationKey: "phase3:asr:v1",
        inputHash: hashProcessingInput(row),
        payload: { phase: 3, processorVersion: 1, artifactType: "transcript" },
        maxAttempts: 3,
      });
      if (changed) created += 1;
    }
    return created;
  }

  private async processJob(job: ProcessingJob) {
    if (job.subjectKind !== "attachment") {
      throw new Error(`Unsupported media processing subject ${job.subjectKind}`);
    }
    const attachment = await this.db.query.attachments.findFirst({
      where: (table, { eq }) => eq(table.id, job.subjectId),
    });
    if (!attachment) throw new Error(`Attachment not found for media processing: ${job.subjectId}`);
    if (!attachment.localPath) throw new Error(`Attachment has no local path: ${attachment.id}`);

    if (job.type === OCR_PROCESSING_JOB) return this.processOcr(attachment);
    if (job.type === ASR_PROCESSING_JOB) return this.processAsr(attachment);
    throw new Error(`Unsupported media processing job ${job.type}/${job.subjectKind}`);
  }

  private async processOcr(attachment: Attachment) {
    if (!isOcrCandidate(attachment))
      throw new Error(`Attachment is not an OCR candidate: ${attachment.id}`);
    const result = await this.ocrClient.ocr(attachment.localPath!, attachment);
    await this.artifacts.upsert({
      sourceKind: "attachment",
      sourceId: attachment.id,
      artifactType: "ocr_text",
      content: {
        text: result.text,
        language: result.language ?? null,
        model: result.model ?? null,
        lines: result.lines ?? [],
      },
      metadata: this.artifactMetadata(attachment, "ocr_service", result.raw),
    });
    return 1;
  }

  private async processAsr(attachment: Attachment) {
    if (!isAsrCandidate(attachment))
      throw new Error(`Attachment is not an ASR candidate: ${attachment.id}`);
    const result = await this.asrClient.transcribe(attachment.localPath!, attachment);
    await this.artifacts.upsert({
      sourceKind: "attachment",
      sourceId: attachment.id,
      artifactType: "transcript",
      content: {
        text: result.text,
        language: result.language ?? null,
        languageProbability: result.languageProbability ?? null,
        durationSeconds: result.durationSeconds ?? null,
        model: result.model ?? null,
        segments: result.segments ?? [],
      },
      metadata: this.artifactMetadata(attachment, "asr_service", result.raw),
    });
    return 1;
  }

  private artifactMetadata(attachment: Attachment, processor: string, raw: unknown) {
    return {
      phase: 3,
      processor,
      processorVersion: 1,
      rawAvailable: raw !== undefined,
      source: {
        attachmentId: attachment.id,
        messageId: attachment.messageId,
        mimeType: attachment.mimeType,
        localPath: attachment.localPath,
        sha256: attachment.sha256,
      },
    };
  }

  private nextRetryAt(attempts: number) {
    const delayMinutes = Math.min(24 * 60, 5 * 2 ** Math.max(0, attempts - 1));
    return new Date(Date.now() + delayMinutes * 60_000);
  }
}
