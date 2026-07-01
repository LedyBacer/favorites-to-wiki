import { createBot } from "../bot/bot.js";
import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../observability/logger.js";
import { LocalStorage } from "../storage/local-storage.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const database = createDatabase(config.DATABASE_URL);
const bot = createBot(config, database.db, logger);

process.once("SIGINT", () => {
  void bot.stop();
  void database.close();
});
process.once("SIGTERM", () => {
  void bot.stop();
  void database.close();
});

logger.info("Starting Telegram bot");
logger.info("Applying database migrations");
await runMigrations(database.db);
logger.info({ migrationSuccess: true }, "Database migrations applied");

await new LocalStorage(config.STORAGE_ROOT).ensureReady();
const botInfo = await bot.api.getMe();
logger.info(
  {
    nodeEnv: config.NODE_ENV,
    storageRoot: config.STORAGE_ROOT,
    maxAttachmentBytes: config.MAX_ATTACHMENT_BYTES,
    maxAttachmentDownloadAttempts: config.MAX_ATTACHMENT_DOWNLOAD_ATTEMPTS,
    searchResultLimit: config.SEARCH_RESULT_LIMIT,
    embeddingServiceConfigured: Boolean(config.EMBEDDING_SERVICE_URL),
    embeddingModel: config.EMBEDDING_MODEL,
    embeddingDimensions: config.EMBEDDING_DIMENSIONS ?? null,
    embeddingMaxInputChars: config.EMBEDDING_MAX_INPUT_CHARS,
    botAcknowledgements: config.BOT_ACKNOWLEDGEMENTS,
    allowedUserCount: config.TELEGRAM_ALLOWED_USER_IDS.length,
    migrationSuccess: true,
    bot: {
      id: botInfo.id,
      username: botInfo.username,
      firstName: botInfo.first_name,
      canJoinGroups: botInfo.can_join_groups,
      canReadAllGroupMessages: botInfo.can_read_all_group_messages,
      supportsInlineQueries: botInfo.supports_inline_queries,
    },
  },
  "Startup summary",
);

await bot.start();
