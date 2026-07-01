import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { LlmClassificationService } from "../domain/llm/llm-classification-service.js";
import { createLogger } from "../observability/logger.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_URL);
const service = new LlmClassificationService(database.db, config);
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  const { limit, loop, intervalMs, reclassify } = parseArgs(process.argv.slice(2));
  const workerId = `classify-cli-${process.pid}`;

  if (!loop) {
    const summary = await service.enqueueAndProcess(workerId, limit, reclassify);
    console.log(JSON.stringify(summary, null, 2));
  } else {
    logger.info({ workerId, limit, intervalMs, reclassify }, "Starting classification worker loop");
    while (!stopping) {
      const summary = await service.enqueueAndProcess(workerId, limit, reclassify);
      logger.info(summary, "Classification batch complete");
      if (!stopping) await sleep(intervalMs);
    }
    logger.info({ workerId }, "Stopping classification worker loop");
  }
} finally {
  await database.close();
}

function parseArgs(args: string[]) {
  const loop = args.includes("--loop");
  const reclassify = args.includes("--reclassify");
  const limitArg = args.find((arg) => /^\d+$/u.test(arg));
  const intervalArg = args.find((arg) => arg.startsWith("--interval-ms="));
  const limit = limitArg ? Number(limitArg) : 20;
  const intervalMs = intervalArg ? Number(intervalArg.split("=")[1]) : 60_000;

  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error(
      "Usage: npm run classify:run -- [limit] [--reclassify] [--loop] [--interval-ms=60000]",
    );
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60 * 60 * 1000) {
    throw new Error("--interval-ms must be between 1000 and 3600000");
  }
  return { limit, loop, intervalMs, reclassify };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
