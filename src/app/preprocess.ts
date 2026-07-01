import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { PreprocessingService } from "../domain/preprocessing/preprocessing-service.js";
import { createLogger } from "../observability/logger.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_URL);
const service = new PreprocessingService(database.db);
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  const { limit, loop, intervalMs } = parseArgs(process.argv.slice(2));
  const workerId = `preprocess-cli-${process.pid}`;

  if (!loop) {
    const summary = await service.enqueueAndProcess(workerId, limit);
    console.log(JSON.stringify(summary, null, 2));
  } else {
    logger.info({ workerId, limit, intervalMs }, "Starting preprocessing worker loop");
    while (!stopping) {
      const summary = await service.enqueueAndProcess(workerId, limit);
      logger.info(summary, "Preprocessing batch complete");
      if (!stopping) await sleep(intervalMs);
    }
    logger.info({ workerId }, "Stopping preprocessing worker loop");
  }
} finally {
  await database.close();
}

function parseArgs(args: string[]) {
  const loop = args.includes("--loop");
  const limitArg = args.find((arg) => /^\d+$/u.test(arg));
  const intervalArg = args.find((arg) => arg.startsWith("--interval-ms="));
  const limit = limitArg ? Number(limitArg) : 50;
  const intervalMs = intervalArg ? Number(intervalArg.split("=")[1]) : 30_000;

  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("Usage: npm run preprocess:run -- [limit] [--loop] [--interval-ms=30000]");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60 * 60 * 1000) {
    throw new Error("--interval-ms must be between 1000 and 3600000");
  }
  return { limit, loop, intervalMs };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
