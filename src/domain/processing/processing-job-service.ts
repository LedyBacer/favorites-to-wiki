import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import type { ProcessingJob } from "../../db/schema.js";

export interface ClaimProcessingJobsOptions {
  workerId: string;
  types?: string[];
  limit?: number;
}

export interface EnqueueOrRefreshJobInput {
  type: string;
  subjectKind: string;
  subjectId: string;
  generationKey: string;
  inputHash: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export class ProcessingJobService {
  constructor(private readonly db: Database) {}

  async enqueueOrRefresh(input: EnqueueOrRefreshJobInput): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      insert into processing_jobs (
        type,
        subject_kind,
        subject_id,
        generation_key,
        input_hash,
        payload,
        max_attempts
      )
      values (
        ${input.type},
        ${input.subjectKind},
        ${input.subjectId},
        ${input.generationKey},
        ${input.inputHash},
        ${JSON.stringify(input.payload ?? {})}::jsonb,
        ${input.maxAttempts ?? 5}
      )
      on conflict (type, subject_kind, subject_id)
      do update set
        generation_key = excluded.generation_key,
        input_hash = excluded.input_hash,
        payload = excluded.payload,
        max_attempts = excluded.max_attempts,
        status = case
          when processing_jobs.generation_key is distinct from excluded.generation_key
            or processing_jobs.input_hash is distinct from excluded.input_hash
          then 'pending'::processing_job_status
          else processing_jobs.status
        end,
        attempts = case
          when processing_jobs.generation_key is distinct from excluded.generation_key
            or processing_jobs.input_hash is distinct from excluded.input_hash
          then 0
          else processing_jobs.attempts
        end,
        locked_by = case
          when processing_jobs.generation_key is distinct from excluded.generation_key
            or processing_jobs.input_hash is distinct from excluded.input_hash
          then null
          else processing_jobs.locked_by
        end,
        locked_at = case
          when processing_jobs.generation_key is distinct from excluded.generation_key
            or processing_jobs.input_hash is distinct from excluded.input_hash
          then null
          else processing_jobs.locked_at
        end,
        last_error = case
          when processing_jobs.generation_key is distinct from excluded.generation_key
            or processing_jobs.input_hash is distinct from excluded.input_hash
          then null
          else processing_jobs.last_error
        end,
        run_after = case
          when processing_jobs.generation_key is distinct from excluded.generation_key
            or processing_jobs.input_hash is distinct from excluded.input_hash
          then now()
          else processing_jobs.run_after
        end,
        completed_at = case
          when processing_jobs.generation_key is distinct from excluded.generation_key
            or processing_jobs.input_hash is distinct from excluded.input_hash
          then null
          else processing_jobs.completed_at
        end,
        updated_at = now()
      where processing_jobs.generation_key is distinct from excluded.generation_key
        or processing_jobs.input_hash is distinct from excluded.input_hash
        or processing_jobs.payload is distinct from excluded.payload
      returning id
    `);
    return result.rows.length > 0;
  }

  async claimPendingJobs(options: ClaimProcessingJobsOptions): Promise<ProcessingJob[]> {
    const limit = options.limit ?? 10;
    if (limit < 1 || limit > 5000) {
      throw new Error("Processing job claim limit must be between 1 and 5000");
    }

    const typeFilter =
      options.types && options.types.length > 0
        ? sql`and type in (${sql.join(
            options.types.map((type) => sql`${type}`),
            sql`, `,
          )})`
        : sql``;

    const result = await this.db.execute<ProcessingJob>(sql`
      with claimable as (
        select id
        from processing_jobs
        where status in ('pending', 'failed')
          and run_after <= now()
          and attempts < max_attempts
          ${typeFilter}
        order by run_after asc, created_at asc
        limit ${limit}
        for update skip locked
      )
      update processing_jobs
      set
        status = 'running',
        attempts = processing_jobs.attempts + 1,
        locked_by = ${options.workerId},
        locked_at = now(),
        last_error = null,
        updated_at = now()
      from claimable
      where processing_jobs.id = claimable.id
      returning
        processing_jobs.id,
        processing_jobs.type,
        processing_jobs.subject_kind as "subjectKind",
        processing_jobs.subject_id as "subjectId",
        processing_jobs.status,
        processing_jobs.attempts,
        processing_jobs.max_attempts as "maxAttempts",
        processing_jobs.locked_by as "lockedBy",
        processing_jobs.locked_at as "lockedAt",
        processing_jobs.input_hash as "inputHash",
        processing_jobs.generation_key as "generationKey",
        processing_jobs.payload,
        processing_jobs.last_error as "lastError",
        processing_jobs.run_after as "runAfter",
        processing_jobs.completed_at as "completedAt",
        processing_jobs.created_at as "createdAt",
        processing_jobs.updated_at as "updatedAt"
    `);

    return result.rows;
  }

  async completeJob(jobId: string): Promise<void> {
    await this.db.execute(sql`
      update processing_jobs
      set
        status = 'completed',
        locked_by = null,
        locked_at = null,
        completed_at = now(),
        updated_at = now()
      where id = ${jobId}
    `);
  }

  async failJob(jobId: string, error: unknown, retryAfter: Date): Promise<void> {
    await this.db.execute(sql`
      update processing_jobs
      set
        status = case when attempts >= max_attempts then 'failed'::processing_job_status else 'pending'::processing_job_status end,
        locked_by = null,
        locked_at = null,
        last_error = ${error instanceof Error ? error.message : String(error)},
        run_after = case when attempts >= max_attempts then run_after else ${retryAfter} end,
        updated_at = now()
      where id = ${jobId}
    `);
  }

  async releaseStaleRunningJobs(lockTimeoutMinutes: number): Promise<number> {
    if (lockTimeoutMinutes < 1 || lockTimeoutMinutes > 24 * 60) {
      throw new Error("Processing job lock timeout must be between 1 and 1440 minutes");
    }

    const result = await this.db.execute<{ id: string }>(sql`
      update processing_jobs
      set
        status = case when attempts >= max_attempts then 'failed'::processing_job_status else 'pending'::processing_job_status end,
        locked_by = null,
        locked_at = null,
        last_error = coalesce(last_error, 'Processing job lock expired'),
        updated_at = now()
      where status = 'running'
        and locked_at < now() - (${lockTimeoutMinutes} * interval '1 minute')
      returning id
    `);

    return result.rows.length;
  }
}
