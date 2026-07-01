import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { PipelineOrchestrator } from "../domain/worker/pipeline-orchestrator.js";
import { createLogger } from "../observability/logger.js";
import { LocalStorage } from "../storage/local-storage.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_URL);
const workerId = `pipeline-${process.pid}`;
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

logger.info({ workerId }, "Starting pipeline worker");
logger.info("Applying database migrations");
await runMigrations(database.db);
logger.info({ migrationSuccess: true }, "Database migrations applied");
await new LocalStorage(config.STORAGE_ROOT).ensureReady();

const orchestrator = new PipelineOrchestrator(database.db, config, logger);
logger.info(
  {
    workerId,
    batchSize: config.WORKER_BATCH_SIZE,
    idleMs: config.WORKER_IDLE_MS,
    ocrConfigured: Boolean(config.OCR_SERVICE_URL),
    asrConfigured: Boolean(config.ASR_SERVICE_URL),
    embeddingConfigured: Boolean(config.EMBEDDING_SERVICE_URL),
    llmConfigured: Boolean(config.LLM_SERVICE_URL),
  },
  "Pipeline worker startup summary",
);

try {
  while (!stopping) {
    try {
      await orchestrator.runOnce({ workerId, batchSize: config.WORKER_BATCH_SIZE });
    } catch (error) {
      logger.error({ error }, "Pipeline worker loop failed");
    }
    await sleep(config.WORKER_IDLE_MS);
  }
} finally {
  logger.info({ workerId }, "Stopping pipeline worker");
  await database.close();
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
