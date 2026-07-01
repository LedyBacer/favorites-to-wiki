import { hydrateFiles, type FileFlavor } from "@grammyjs/files";
import { Bot, type Context } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../config/env.js";
import type { Database } from "../db/client.js";
import {
  AttachmentService,
  type AttachmentDownloadSummary,
} from "../domain/attachments/attachment-service.js";
import { EmbeddingService, type EmbeddingSummary } from "../domain/embeddings/embedding-service.js";
import {
  MediaProcessingService,
  type MediaProcessingSummary,
} from "../domain/media-processing/media-processing-service.js";
import { MessageService } from "../domain/messages/message-service.js";
import {
  PreprocessingService,
  type PreprocessingSummary,
} from "../domain/preprocessing/preprocessing-service.js";
import { SearchService } from "../search/search-service.js";
import { LocalStorage } from "../storage/local-storage.js";
import {
  formatRecentMessage,
  formatSearchResult,
  formatSemanticSearchResult,
  formatSavedAck,
  parseLimitPrefix,
  splitTelegramMessage,
} from "./commands/format.js";
import { parseTelegramMessage } from "./handlers/telegram-message-parser.js";
import { isAllowedTelegramUser } from "./middleware/allowlist.js";

type BotContext = FileFlavor<Context>;

function isAttachmentDownloadSummary(value: unknown): value is AttachmentDownloadSummary {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Record<keyof AttachmentDownloadSummary, unknown>>;
  return (
    typeof candidate.attempted === "number" &&
    typeof candidate.downloaded === "number" &&
    typeof candidate.reused === "number" &&
    typeof candidate.skippedTooLarge === "number" &&
    typeof candidate.failed === "number"
  );
}

function assertAttachmentDownloadSummary(value: unknown): AttachmentDownloadSummary {
  if (!isAttachmentDownloadSummary(value)) {
    throw new Error("Attachment retry returned an invalid summary");
  }
  return value;
}

function formatPreprocessingSummary(summary: PreprocessingSummary) {
  return [
    "Предобработка завершена",
    `Создано задач: ${summary.jobsCreated}`,
    `Взято задач: ${summary.jobsClaimed}`,
    `Завершено: ${summary.jobsCompleted}`,
    `Ошибок: ${summary.jobsFailed}`,
    `Артефактов записано: ${summary.artifactsWritten}`,
  ].join("\n");
}

function formatMediaProcessingSummary(summary: MediaProcessingSummary) {
  return [
    "OCR/ASR обработка завершена",
    `Создано задач: ${summary.jobsCreated}`,
    `Взято задач: ${summary.jobsClaimed}`,
    `Завершено: ${summary.jobsCompleted}`,
    `Ошибок: ${summary.jobsFailed}`,
    `Артефактов записано: ${summary.artifactsWritten}`,
  ].join("\n");
}

function formatEmbeddingSummary(summary: EmbeddingSummary) {
  return [
    "Индексация embeddings завершена",
    `Создано задач: ${summary.jobsCreated}`,
    `Взято задач: ${summary.jobsClaimed}`,
    `Завершено: ${summary.jobsCompleted}`,
    `Ошибок: ${summary.jobsFailed}`,
    `Embeddings записано: ${summary.embeddingsWritten}`,
  ].join("\n");
}

export function createBot(config: AppConfig, db: Database, logger: Logger) {
  const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(hydrateFiles(config.TELEGRAM_BOT_TOKEN));

  const messageService = new MessageService(db);
  const searchService = new SearchService(db);
  const preprocessingService = new PreprocessingService(db);
  const mediaProcessingService = new MediaProcessingService(db, config);
  const embeddingService = new EmbeddingService(db, config);
  const storage = new LocalStorage(config.STORAGE_ROOT);
  const attachmentService = new AttachmentService(
    db,
    storage,
    bot.api,
    config.TELEGRAM_BOT_TOKEN,
    config.MAX_ATTACHMENT_BYTES,
    config.MAX_ATTACHMENT_DOWNLOAD_ATTEMPTS,
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
    await ctx.reply(
      "Личный inbox работает. Присылай текст, ссылки, медиа, файлы или используй /search.",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "/search запрос - поиск по сохраненному",
        "/search 10 запрос - поиск с лимитом",
        "/recent - последние сохраненные",
        "/recent 10 - последние сохраненные с лимитом",
        "/status - состояние хранилища и базы",
        "/preprocess - запустить пакет детерминированной предобработки",
        "/process_media - запустить пакет OCR/ASR обработки",
        "/embed - запустить пакет индексации embeddings",
        "/semantic запрос - семантический поиск по embeddings",
      ].join("\n"),
    );
  });

  bot.command("recent", async (ctx) => {
    const { limit } = parseLimitPrefix(ctx.match, 5, config.SEARCH_RESULT_LIMIT);
    const rows = await messageService.recent(limit);
    const text = rows.length
      ? rows.map(formatRecentMessage).join("\n\n")
      : "Сохраненных сообщений пока нет.";
    for (const chunk of splitTelegramMessage(text)) {
      await ctx.reply(chunk);
    }
  });

  bot.command("status", async (ctx) => {
    try {
      await storage.ensureReady();
      const stats = await messageService.stats();
      const preprocessingStats = await preprocessingService.stats();
      const mediaProcessingStats = await mediaProcessingService.stats();
      const embeddingStats = await embeddingService.stats();
      await ctx.reply(
        [
          "Статус: ok",
          `PostgreSQL: ok`,
          `Хранилище: ok`,
          `Сообщений: ${stats.messages_count}`,
          `Вложений: ${stats.attachments_count}`,
          `Скачано: ${stats.downloaded_count}`,
          `Ожидает: ${stats.pending_count}`,
          `Ошибок: ${stats.failed_count}`,
          `Слишком больших: ${stats.skipped_too_large_count}`,
          `Предобработка ожидает: ${preprocessingStats.pending_count}`,
          `Предобработка выполняется: ${preprocessingStats.running_count}`,
          `Предобработка завершена: ${preprocessingStats.completed_count}`,
          `Предобработка ошибок: ${preprocessingStats.failed_count}`,
          `OCR/ASR ожидает: ${mediaProcessingStats.pending_count}`,
          `OCR/ASR выполняется: ${mediaProcessingStats.running_count}`,
          `OCR/ASR завершено: ${mediaProcessingStats.completed_count}`,
          `OCR/ASR ошибок: ${mediaProcessingStats.failed_count}`,
          `Embeddings ожидает: ${embeddingStats.pending_count}`,
          `Embeddings выполняется: ${embeddingStats.running_count}`,
          `Embeddings завершено: ${embeddingStats.completed_count}`,
          `Embeddings ошибок: ${embeddingStats.failed_count}`,
          `Производных артефактов: ${preprocessingStats.artifact_count}`,
          `OCR/ASR артефактов: ${mediaProcessingStats.artifact_count}`,
          `Embeddings: ${embeddingStats.embedding_count}`,
        ].join("\n"),
      );
    } catch (error) {
      logger.error({ error }, "Status check failed");
      await ctx.reply(
        `Статус: degraded\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  bot.command("retry_attachments", async (ctx) => {
    const retryResult: unknown = await attachmentService.retryFailedAttachments(20);
    const summary = assertAttachmentDownloadSummary(retryResult);
    await ctx.reply(
      [
        "Повторная загрузка вложений завершена",
        `Проверено: ${summary.attempted}`,
        `Скачано: ${summary.downloaded}`,
        `Переиспользовано: ${summary.reused}`,
        `Слишком большие: ${summary.skippedTooLarge}`,
        `Ошибок: ${summary.failed}`,
      ].join("\n"),
    );
  });

  bot.command("preprocess", async (ctx) => {
    const { limit } = parseLimitPrefix(ctx.match, 20, 100);
    const summary = await preprocessingService.enqueueAndProcess(`telegram-${ctx.from?.id}`, limit);
    await ctx.reply(formatPreprocessingSummary(summary));
  });

  bot.command("process_media", async (ctx) => {
    const { limit, rest } = parseLimitPrefix(ctx.match, 5, 50);
    const mode = rest === "ocr" || rest === "asr" ? rest : "all";
    const summary = await mediaProcessingService.enqueueAndProcess(
      `telegram-${ctx.from?.id}`,
      limit,
      mode,
    );
    await ctx.reply(formatMediaProcessingSummary(summary));
  });

  bot.command("embed", async (ctx) => {
    const { limit, rest } = parseLimitPrefix(ctx.match, 5, 50);
    const reindex = rest === "reindex" || rest === "--reindex";
    const summary = await embeddingService.enqueueAndProcess(
      `telegram-${ctx.from?.id}`,
      limit,
      reindex,
    );
    await ctx.reply(formatEmbeddingSummary(summary));
  });

  bot.command("search", async (ctx) => {
    const { limit, rest: query } = parseLimitPrefix(
      ctx.match,
      config.SEARCH_RESULT_LIMIT,
      config.SEARCH_RESULT_LIMIT,
    );
    if (!query) {
      await ctx.reply("Использование: /search запрос");
      return;
    }
    const results = await searchService.search(query, limit);
    if (results.length === 0) {
      await ctx.reply("Ничего не найдено.");
      return;
    }
    const text = results.map((result) => formatSearchResult(result, query)).join("\n\n");
    for (const chunk of splitTelegramMessage(text)) {
      await ctx.reply(chunk);
    }
  });

  bot.command("semantic", async (ctx) => {
    const { limit, rest: query } = parseLimitPrefix(
      ctx.match,
      config.SEARCH_RESULT_LIMIT,
      config.SEARCH_RESULT_LIMIT,
    );
    if (!query) {
      await ctx.reply("Использование: /semantic запрос");
      return;
    }
    const results = await embeddingService.semanticSearch(query, limit);
    if (results.length === 0) {
      await ctx.reply("Ничего не найдено.");
      return;
    }
    const text = results.map((result) => formatSemanticSearchResult(result, query)).join("\n\n");
    for (const chunk of splitTelegramMessage(text)) {
      await ctx.reply(chunk);
    }
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
