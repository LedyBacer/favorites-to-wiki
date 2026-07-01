import { promises as fs } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { AppConfig } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { Attachment, ProcessingJob } from "../../db/schema.js";
import { isOcrCandidate } from "../media-processing/media-kind.js";
import { ProcessingJobService } from "../processing/processing-job-service.js";
import { DerivedArtifactService } from "../preprocessing/derived-artifact-service.js";
import { OllamaChatClient } from "./ollama-chat-client.js";
import { IMAGE_ANALYSIS_SYSTEM_PROMPT, imageAnalysisUserPrompt } from "./prompts.js";
import {
  imageAnalysisJsonSchema,
  imageAnalysisOutputSchema,
  type ImageAnalysisOutput,
} from "./schemas.js";

export const IMAGE_ANALYSIS_JOB = "image_analysis";
export const IMAGE_ANALYSIS_JOB_TYPES = [IMAGE_ANALYSIS_JOB] as const;
export const IMAGE_ANALYSIS_PROVIDER = "ollama";

export interface ImageAnalysisSummary {
  jobsCreated: number;
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  artifactsWritten: number;
}

export class ImageAnalysisService {
  private readonly processingJobs: ProcessingJobService;
  private readonly artifacts: DerivedArtifactService;
  private readonly client: OllamaChatClient;

  constructor(
    private readonly db: Database,
    private readonly config: Pick<
      AppConfig,
      | "STORAGE_ROOT"
      | "LLM_SERVICE_URL"
      | "LLM_SERVICE_API_KEY"
      | "LLM_VISION_MODEL"
      | "LLM_SERVICE_TIMEOUT_MS"
      | "LLM_IMAGE_MAX_ATTACHMENT_BYTES"
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

  async enqueueMissing(limit = 100, reprocess = false): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new Error("Image analysis enqueue limit must be between 1 and 5000");
    }

    if (reprocess) {
      await this.reopenExistingJobs(limit);
    }

    const result = await this.db.execute<{ id: string }>(sql`
      insert into processing_jobs (type, subject_kind, subject_id, payload, max_attempts)
      select
        ${IMAGE_ANALYSIS_JOB},
        'attachment',
        attachments.id,
        jsonb_build_object(
          'phase', '5.1',
          'processorVersion', 1,
          'provider', ${IMAGE_ANALYSIS_PROVIDER}::text,
          'model', ${this.config.LLM_VISION_MODEL}::text,
          'artifactType', 'image_description'
        ),
        3
      from attachments
      where attachments.download_status = 'downloaded'
        and attachments.local_path is not null
        and (
          lower(coalesce(attachments.mime_type, '')) like 'image/%'
          or lower(coalesce(attachments.original_file_name, attachments.local_path, '')) ~ '\\.(bmp|gif|jpe?g|png|tiff?|webp)$'
        )
        and coalesce(attachments.size_bytes, 0) <= ${this.config.LLM_IMAGE_MAX_ATTACHMENT_BYTES}
        and not exists (
          select 1
          from processing_jobs existing
          where existing.type = ${IMAGE_ANALYSIS_JOB}
            and existing.subject_kind = 'attachment'
            and existing.subject_id = attachments.id
        )
      order by attachments.created_at asc
      limit ${limit}
      on conflict (type, subject_kind, subject_id) do nothing
      returning id
    `);
    return result.rows.length;
  }

  async processBatch(workerId: string, limit = 20): Promise<ImageAnalysisSummary> {
    const summary: ImageAnalysisSummary = {
      jobsCreated: 0,
      jobsClaimed: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      artifactsWritten: 0,
    };

    await this.processingJobs.releaseStaleRunningJobs(120);
    const jobs = await this.processingJobs.claimPendingJobs({
      workerId,
      types: [...IMAGE_ANALYSIS_JOB_TYPES],
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
    reprocess = false,
  ): Promise<ImageAnalysisSummary> {
    const jobsCreated = await this.enqueueMissing(limit, reprocess);
    const summary = await this.processBatch(workerId, limit);
    return { ...summary, jobsCreated };
  }

  async stats() {
    const result = await this.db.execute<{
      pending_count: string;
      running_count: string;
      completed_count: string;
      failed_count: string;
      artifact_count: string;
    }>(sql`
      select
        (select count(*) from processing_jobs where type = ${IMAGE_ANALYSIS_JOB} and status = 'pending') as pending_count,
        (select count(*) from processing_jobs where type = ${IMAGE_ANALYSIS_JOB} and status = 'running') as running_count,
        (select count(*) from processing_jobs where type = ${IMAGE_ANALYSIS_JOB} and status = 'completed') as completed_count,
        (select count(*) from processing_jobs where type = ${IMAGE_ANALYSIS_JOB} and status = 'failed') as failed_count,
        (select count(*) from derived_artifacts where artifact_type = 'image_description') as artifact_count
    `);
    return result.rows[0]!;
  }

  private async processJob(job: ProcessingJob) {
    if (job.type !== IMAGE_ANALYSIS_JOB || job.subjectKind !== "attachment") {
      throw new Error(`Unsupported image analysis job ${job.type}/${job.subjectKind}`);
    }
    const attachment = await this.db.query.attachments.findFirst({
      where: (table, { eq }) => eq(table.id, job.subjectId),
    });
    if (!attachment) throw new Error(`Attachment not found for image analysis: ${job.subjectId}`);
    if (!attachment.localPath) throw new Error(`Attachment has no local path: ${attachment.id}`);
    if (!isOcrCandidate(attachment)) {
      throw new Error(`Attachment is not an image analysis candidate: ${attachment.id}`);
    }

    const imageBase64 = await this.readAttachmentBase64(attachment);
    const result = await this.client.chatJson({
      model: this.config.LLM_VISION_MODEL,
      schema: imageAnalysisJsonSchema,
      responseSchema: imageAnalysisOutputSchema,
      messages: [
        { role: "system", content: IMAGE_ANALYSIS_SYSTEM_PROMPT },
        {
          role: "user",
          content: imageAnalysisUserPrompt(attachmentContext(attachment)),
          images: [imageBase64],
        },
      ],
    });

    await this.writeArtifact(attachment, result.value, result.model, result.raw);
    return 1;
  }

  private async readAttachmentBase64(attachment: Attachment) {
    const fullPath = path.resolve(this.config.STORAGE_ROOT, attachment.localPath!);
    const storageRoot = path.resolve(this.config.STORAGE_ROOT);
    if (!fullPath.startsWith(`${storageRoot}${path.sep}`)) {
      throw new Error(`Attachment path escapes storage root: ${attachment.localPath}`);
    }
    const stat = await fs.stat(fullPath);
    if (stat.size > this.config.LLM_IMAGE_MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is too large for image analysis: ${attachment.id}`);
    }
    return fs.readFile(fullPath, { encoding: "base64" });
  }

  private async writeArtifact(
    attachment: Attachment,
    output: ImageAnalysisOutput,
    returnedModel: string,
    raw: unknown,
  ) {
    await this.artifacts.upsert({
      sourceKind: "attachment",
      sourceId: attachment.id,
      artifactType: "image_description",
      artifactKey: `${IMAGE_ANALYSIS_PROVIDER}:${this.config.LLM_VISION_MODEL}`,
      content: {
        text: output.description,
        description: output.description,
        visibleText: output.visibleText,
        language: output.language,
        objects: output.objects,
        tags: output.tags,
        safetyNotes: output.safetyNotes,
        confidence: output.confidence,
        provider: IMAGE_ANALYSIS_PROVIDER,
        model: this.config.LLM_VISION_MODEL,
        returnedModel,
      },
      metadata: {
        phase: "5.1",
        processor: "image_analysis_service",
        processorVersion: 1,
        rawAvailable: raw !== undefined,
        source: {
          attachmentId: attachment.id,
          messageId: attachment.messageId,
          mimeType: attachment.mimeType,
          localPath: attachment.localPath,
          sha256: attachment.sha256,
        },
      },
    });
  }

  private async reopenExistingJobs(limit: number) {
    const result = await this.db.execute<{ id: string }>(sql`
      select attachments.id
      from attachments
      join processing_jobs job
        on job.type = ${IMAGE_ANALYSIS_JOB}
        and job.subject_kind = 'attachment'
        and job.subject_id = attachments.id
      where job.status in ('completed', 'failed')
      order by attachments.created_at asc
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
      where type = ${IMAGE_ANALYSIS_JOB}
        and subject_kind = 'attachment'
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

function attachmentContext(attachment: Attachment) {
  return [
    attachment.originalFileName ? `file: ${attachment.originalFileName}` : undefined,
    attachment.mimeType ? `mime: ${attachment.mimeType}` : undefined,
    attachment.sizeBytes ? `sizeBytes: ${attachment.sizeBytes}` : undefined,
    attachment.sha256 ? `sha256: ${attachment.sha256}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
