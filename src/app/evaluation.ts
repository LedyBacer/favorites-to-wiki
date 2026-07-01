import { readFile, writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../observability/logger.js";

const annotationSchema = z.object({
  exportedAt: z.string().optional(),
  items: z.array(
    z.object({
      recordId: z.string().uuid(),
      correctRecordType: z.boolean().optional(),
      correctBundle: z.boolean().optional(),
      expectedTitle: z.string().optional(),
      needsClarification: z.boolean().optional(),
      decision: z.enum(["accept", "reject"]).optional(),
      comment: z.string().optional(),
    }),
  ),
});

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_URL);

try {
  await runMigrations(database.db);
  const [command, pathArg, limitArg] = process.argv.slice(2);
  if (command === "export") {
    const path = pathArg ?? "classification-evaluation.json";
    const limit = Number.isSafeInteger(Number(limitArg)) ? Math.min(Math.max(Number(limitArg), 1), 500) : 100;
    const rows = await database.db.execute(sql`
      select
        r.id as "recordId",
        r.type,
        r.title,
        r.body,
        r.status,
        r.metadata,
        r.source_message_id as "sourceMessageId",
        r.source_bundle_id as "sourceBundleId",
        m.current_text as "sourceText",
        coalesce(bundle_stats.message_count, 0)::int as "bundleMessageCount"
      from records r
      left join messages m on m.id = r.source_message_id
      left join lateral (
        select count(*) as message_count
        from bundle_messages bm
        where bm.bundle_id = r.source_bundle_id
      ) bundle_stats on true
      where r.status = 'proposed'
      order by r.updated_at desc
      limit ${limit}
    `);
    await writeFile(
      path,
      `${JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          instructions: {
            correctRecordType: "boolean",
            correctBundle: "boolean",
            expectedTitle: "string",
            needsClarification: "boolean",
            decision: "accept or reject",
            comment: "string",
          },
          items: rows.rows,
        },
        null,
        2,
      )}\n`,
    );
    logger.info({ path, count: rows.rows.length }, "Evaluation sample exported");
  } else if (command === "import") {
    if (!pathArg) throw new Error("Usage: npm run evaluation -- import /path/to/file.json");
    const parsed = annotationSchema.parse(JSON.parse(await readFile(pathArg, "utf8")));
    for (const item of parsed.items) {
      await database.db.execute(sql`
        insert into review_actions (
          target_kind,
          target_id,
          action,
          previous_values,
          new_values,
          telegram_user_id
        )
        values (
          'record',
          ${item.recordId},
          'evaluation_feedback',
          '{}'::jsonb,
          ${JSON.stringify(item)}::jsonb,
          0
        )
      `);
    }
    logger.info({ path: pathArg, count: parsed.items.length }, "Evaluation feedback imported");
  } else {
    throw new Error("Usage: npm run evaluation -- export [path] [limit] | import /path/to/file.json");
  }
} finally {
  await database.close();
}
