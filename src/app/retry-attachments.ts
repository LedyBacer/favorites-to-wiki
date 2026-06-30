import { Bot } from "grammy";
import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { AttachmentService } from "../domain/attachments/attachment-service.js";
import { LocalStorage } from "../storage/local-storage.js";

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const storage = new LocalStorage(config.STORAGE_ROOT);
const service = new AttachmentService(
  database.db,
  storage,
  bot.api,
  config.TELEGRAM_BOT_TOKEN,
  config.MAX_ATTACHMENT_BYTES,
  config.MAX_ATTACHMENT_DOWNLOAD_ATTEMPTS,
);

try {
  const limitArg = process.argv[2];
  const limit = limitArg ? Number(limitArg) : 20;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Usage: npm run attachments:retry -- [positive-limit]");
  }
  const summary = await service.retryFailedAttachments(limit);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await database.close();
}
