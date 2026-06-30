import { hydrateFiles, type FileFlavor } from "@grammyjs/files";
import { Bot, type Context } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../config/env.js";
import type { Database } from "../db/client.js";
import { AttachmentService } from "../domain/attachments/attachment-service.js";
import { MessageService } from "../domain/messages/message-service.js";
import { SearchService } from "../search/search-service.js";
import { LocalStorage } from "../storage/local-storage.js";
import {
  formatTelegramDate,
  formatRecentMessage,
  formatSavedAck,
  shortText,
  telegramMessageLink,
} from "./commands/format.js";
import { parseTelegramMessage } from "./handlers/telegram-message-parser.js";
import { isAllowedTelegramUser } from "./middleware/allowlist.js";

type BotContext = FileFlavor<Context>;

export function createBot(config: AppConfig, db: Database, logger: Logger) {
  const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(hydrateFiles(config.TELEGRAM_BOT_TOKEN));

  const messageService = new MessageService(db);
  const searchService = new SearchService(db);
  const storage = new LocalStorage(config.STORAGE_ROOT);
  const attachmentService = new AttachmentService(
    db,
    storage,
    bot.api,
    config.TELEGRAM_BOT_TOKEN,
    config.MAX_ATTACHMENT_BYTES,
  );

  bot.use(async (ctx, next) => {
    if (!isAllowedTelegramUser(ctx.from?.id, config.TELEGRAM_ALLOWED_USER_IDS)) {
      if (ctx.from?.id) {
        logger.warn(
          { telegramUserId: ctx.from.id },
          "Rejected Telegram update from non-allowlisted user",
        );
        await ctx.reply("Access denied.");
      }
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply("Personal inbox is running. Send text, links, media, files, or use /search.");
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "/search query - search saved items",
        "/recent - latest saved items",
        "/status - storage and database status",
      ].join("\n"),
    );
  });

  bot.command("recent", async (ctx) => {
    const rows = await messageService.recent(5);
    await ctx.reply(
      rows.length ? rows.map(formatRecentMessage).join("\n\n") : "No saved messages yet.",
    );
  });

  bot.command("status", async (ctx) => {
    try {
      await storage.ensureReady();
      const stats = await messageService.stats();
      await ctx.reply(
        [
          "Status: ok",
          `PostgreSQL: ok`,
          `Storage: ok`,
          `Messages: ${stats.messages_count}`,
          `Attachments: ${stats.attachments_count}`,
          `Downloaded: ${stats.downloaded_count}`,
        ].join("\n"),
      );
    } catch (error) {
      logger.error({ error }, "Status check failed");
      await ctx.reply(
        `Status: degraded\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  bot.command("search", async (ctx) => {
    const query = ctx.match.trim();
    if (!query) {
      await ctx.reply("Usage: /search query");
      return;
    }
    const results = await searchService.search(query, config.SEARCH_RESULT_LIMIT);
    if (results.length === 0) {
      await ctx.reply("Nothing found.");
      return;
    }
    await ctx.reply(
      results
        .map((result) => {
          const link = telegramMessageLink(result.telegramChatId, result.telegramMessageId);
          return [
            `${formatTelegramDate(result.telegramDate)} · ${result.messageType}`,
            shortText(result.currentText),
            result.attachmentNames ? `Files: ${result.attachmentNames}` : "",
            link ?? "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n"),
    );
  });

  async function saveIncoming(ctx: BotContext) {
    const message = ctx.editedMessage ?? ctx.message;
    if (!message) return;
    const input = parseTelegramMessage(message);
    if (!input) return;
    const result = await messageService.saveTelegramMessage(input);
    await attachmentService.downloadPendingForMessage(result.messageId);

    if (config.BOT_ACKNOWLEDGEMENTS && ctx.message) {
      await ctx.reply(formatSavedAck(input.messageType, result.attachmentCount));
    }
  }

  bot.on("message", async (ctx) => {
    await saveIncoming(ctx);
  });

  bot.on("edited_message", async (ctx) => {
    await saveIncoming(ctx);
  });

  bot.catch((error) => {
    logger.error(
      {
        errorName: error.name,
        message: error.message,
        cause: error.error instanceof Error ? error.error.message : String(error.error),
        updateId: error.ctx.update.update_id,
      },
      "Telegram bot error",
    );
  });

  return bot;
}
