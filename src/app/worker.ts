import { Bot } from "grammy";
import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { AttachmentService } from "../domain/attachments/attachment-service.js";
import { PipelineOrchestrator } from "../domain/worker/pipeline-orchestrator.js";
import { WorkerHeartbeatService } from "../domain/worker/worker-heartbeat-service.js";
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
const storage = new LocalStorage(config.STORAGE_ROOT);
await storage.ensureReady();

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const attachmentService = new AttachmentService(
  database.db,
  storage,
  bot.api,
  config.TELEGRAM_BOT_TOKEN,
  config.MAX_ATTACHMENT_BYTES,
  config.MAX_ATTACHMENT_DOWNLOAD_ATTEMPTS,
);
const heartbeat = new WorkerHeartbeatService(database.db);
const orchestrator = new PipelineOrchestrator(database.db, config, logger, attachmentService);
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
    const startedAt = Date.now();
    await heartbeat.markStarted(workerId, { batchSize: config.WORKER_BATCH_SIZE });
    try {
      await orchestrator.runOnce({ workerId, batchSize: config.WORKER_BATCH_SIZE });
      await heartbeat.markSuccess(workerId, Date.now() - startedAt);
    } catch (error) {
      await heartbeat.markError(workerId, error, Date.now() - startedAt).catch(() => undefined);
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
