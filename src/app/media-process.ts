import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import {
  MediaProcessingService,
  type MediaProcessingMode,
} from "../domain/media-processing/media-processing-service.js";
import { createLogger } from "../observability/logger.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_URL);
const service = new MediaProcessingService(database.db, config);
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  const { limit, loop, intervalMs, mode } = parseArgs(process.argv.slice(2));
  const workerId = `media-process-cli-${process.pid}`;

  if (!loop) {
    const summary = await service.enqueueAndProcess(workerId, limit, mode);
    console.log(JSON.stringify(summary, null, 2));
  } else {
    logger.info({ workerId, limit, intervalMs, mode }, "Starting media processing worker loop");
    while (!stopping) {
      const summary = await service.enqueueAndProcess(workerId, limit, mode);
      logger.info(summary, "Media processing batch complete");
      if (!stopping) await sleep(intervalMs);
    }
    logger.info({ workerId }, "Stopping media processing worker loop");
  }
} finally {
  await database.close();
}

function parseArgs(args: string[]) {
  const loop = args.includes("--loop");
  const limitArg = args.find((arg) => /^\d+$/u.test(arg));
  const intervalArg = args.find((arg) => arg.startsWith("--interval-ms="));
  const modeArg = args.find((arg) => arg.startsWith("--mode="));
  const limit = limitArg ? Number(limitArg) : 20;
  const intervalMs = intervalArg ? Number(intervalArg.split("=")[1]) : 60_000;
  const mode = parseMode(modeArg?.split("=")[1] ?? "all");

  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error(
      "Usage: npm run media:process -- [limit] [--mode=all|ocr|asr] [--loop] [--interval-ms=60000]",
    );
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60 * 60 * 1000) {
    throw new Error("--interval-ms must be between 1000 and 3600000");
  }
  return { limit, loop, intervalMs, mode };
}

function parseMode(value: string): MediaProcessingMode {
  if (value === "all" || value === "ocr" || value === "asr") return value;
  throw new Error("--mode must be one of: all, ocr, asr");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
