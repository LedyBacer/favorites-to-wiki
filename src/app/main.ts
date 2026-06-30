import { createBot } from "../bot/bot.js";
import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { createLogger } from "../observability/logger.js";

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
await bot.start();
