import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";

export class WorkerHeartbeatService {
  constructor(private readonly db: Database) {}

  async markStarted(workerId: string, metadata: Record<string, unknown> = {}) {
    await this.db.execute(sql`
      insert into worker_heartbeats (
        worker_id,
        last_cycle_started_at,
        metadata,
        updated_at
      )
      values (${workerId}, now(), ${JSON.stringify(metadata)}::jsonb, now())
      on conflict (worker_id)
      do update set
        last_cycle_started_at = excluded.last_cycle_started_at,
        metadata = worker_heartbeats.metadata || excluded.metadata,
        updated_at = now()
    `);
  }

  async markSuccess(workerId: string, durationMs: number, metadata: Record<string, unknown> = {}) {
    await this.db.execute(sql`
      insert into worker_heartbeats (
        worker_id,
        last_success_at,
        last_error,
        last_duration_ms,
        metadata,
        updated_at
      )
      values (${workerId}, now(), null, ${Math.round(durationMs)}, ${JSON.stringify(metadata)}::jsonb, now())
      on conflict (worker_id)
      do update set
        last_success_at = excluded.last_success_at,
        last_error = null,
        last_duration_ms = excluded.last_duration_ms,
        metadata = worker_heartbeats.metadata || excluded.metadata,
        updated_at = now()
    `);
  }

  async markError(workerId: string, error: unknown, durationMs: number) {
    await this.db.execute(sql`
      insert into worker_heartbeats (
        worker_id,
        last_error,
        last_duration_ms,
        updated_at
      )
      values (
        ${workerId},
        ${error instanceof Error ? error.message : String(error)},
        ${Math.round(durationMs)},
        now()
      )
      on conflict (worker_id)
      do update set
        last_error = excluded.last_error,
        last_duration_ms = excluded.last_duration_ms,
        updated_at = now()
    `);
  }

  async assertRecentSuccess(maxAgeMs: number) {
    const result = await this.db.execute<{
      worker_id: string;
      last_success_at: Date | string | null;
      age_ms: number | string | null;
      last_error: string | null;
    }>(sql`
      select
        worker_id,
        last_success_at,
        extract(epoch from (now() - last_success_at)) * 1000 as age_ms,
        last_error
      from worker_heartbeats
      order by updated_at desc
      limit 1
    `);
    const row = result.rows[0];
    if (!row?.last_success_at) {
      throw new Error("Worker heartbeat has no successful cycle");
    }
    const ageMs = Number(row.age_ms);
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
      throw new Error(
        `Worker heartbeat stale: last success ${Math.round(ageMs)}ms ago${
          row.last_error ? `; last error: ${row.last_error}` : ""
        }`,
      );
    }
  }
}
