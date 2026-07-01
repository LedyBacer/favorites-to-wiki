import { hydrateFiles, type FileFlavor } from "@grammyjs/files";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../config/env.js";
import type { Database } from "../db/client.js";
import { BundleService } from "../domain/bundles/bundle-service.js";
import {
  AttachmentService,
  type AttachmentDownloadSummary,
} from "../domain/attachments/attachment-service.js";
import { EmbeddingService, type EmbeddingSummary } from "../domain/embeddings/embedding-service.js";
import {
  MediaProcessingService,
  type MediaProcessingSummary,
} from "../domain/media-processing/media-processing-service.js";
import {
  ImageAnalysisService,
  type ImageAnalysisSummary,
} from "../domain/llm/image-analysis-service.js";
import {
  LlmClassificationService,
  type LlmClassificationSummary,
} from "../domain/llm/llm-classification-service.js";
import { MessageService } from "../domain/messages/message-service.js";
import {
  PreprocessingService,
  type PreprocessingSummary,
} from "../domain/preprocessing/preprocessing-service.js";
import { SearchService } from "../search/search-service.js";
import { ReviewService } from "../domain/review/review-service.js";
import { LocalStorage } from "../storage/local-storage.js";
import {
  formatInboxProposal,
  formatRecentMessage,
  formatProposal,
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

function formatImageAnalysisSummary(summary: ImageAnalysisSummary) {
  return [
    "Анализ изображений завершен",
    `Создано задач: ${summary.jobsCreated}`,
    `Взято задач: ${summary.jobsClaimed}`,
    `Завершено: ${summary.jobsCompleted}`,
    `Ошибок: ${summary.jobsFailed}`,
    `Артефактов записано: ${summary.artifactsWritten}`,
  ].join("\n");
}

function formatClassificationSummary(summary: LlmClassificationSummary) {
  return [
    "LLM-классификация завершена",
    `Создано задач: ${summary.jobsCreated}`,
    `Взято задач: ${summary.jobsClaimed}`,
    `Завершено: ${summary.jobsCompleted}`,
    `Ошибок: ${summary.jobsFailed}`,
    `Records предложено: ${summary.recordsWritten}`,
    `Entities предложено: ${summary.entitiesWritten}`,
    `Relations предложено: ${summary.relationsWritten}`,
    `Артефактов записано: ${summary.artifactsWritten}`,
  ].join("\n");
}

export function createBot(config: AppConfig, db: Database, logger: Logger) {
  const bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);
  bot.api.config.use(hydrateFiles(config.TELEGRAM_BOT_TOKEN));

  const messageService = new MessageService(db);
  const bundleService = new BundleService(db);
  const searchService = new SearchService(db);
  const preprocessingService = new PreprocessingService(db);
  const mediaProcessingService = new MediaProcessingService(db, config);
  const embeddingService = new EmbeddingService(db, config);
  const imageAnalysisService = new ImageAnalysisService(db, config);
  const classificationService = new LlmClassificationService(db, config);
  const reviewService = new ReviewService(db, { llmMaxInputChars: config.LLM_MAX_INPUT_CHARS });
  const pendingCorrections = new Map<number, string>();
  const pendingClarificationReplies = new Map<number, string>();
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
      "Личный inbox работает. Присылай текст, ссылки, медиа, файлы или используй /find.",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      [
        "/find запрос - поиск по сохраненному",
        "/inbox - предложения на проверку",
        "/recent - последние сохраненные",
        "/recent 10 - последние сохраненные с лимитом",
        "/settings - текущие настройки бота",
        "/help - эта справка",
      ].join("\n"),
    );
  });

  bot.command("settings", async (ctx) => {
    await ctx.reply(
      [
        "Настройки",
        `Подтверждения сохранения: ${config.BOT_ACKNOWLEDGEMENTS ? "включены" : "выключены"}`,
        `Лимит результатов поиска: ${config.SEARCH_RESULT_LIMIT}`,
        `Embeddings: ${config.EMBEDDING_SERVICE_URL ? "настроены" : "не настроены"}`,
        `LLM: ${config.LLM_SERVICE_URL ? "настроен" : "не настроен"}`,
        `OCR: ${config.OCR_SERVICE_URL ? "настроен" : "не настроен"}`,
        `ASR: ${config.ASR_SERVICE_URL ? "настроен" : "не настроен"}`,
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
      const bundleStats = await bundleService.stats();
      const preprocessingStats = await preprocessingService.stats();
      const mediaProcessingStats = await mediaProcessingService.stats();
      const embeddingStats = await embeddingService.stats();
      const imageAnalysisStats = await imageAnalysisService.stats();
      const classificationStats = await classificationService.stats();
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
          `Авто-bundles: ${bundleStats.bundle_count}`,
          `Сообщений в bundles: ${bundleStats.grouped_message_count}`,
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
          `Анализ изображений ожидает: ${imageAnalysisStats.pending_count}`,
          `Анализ изображений выполняется: ${imageAnalysisStats.running_count}`,
          `Анализ изображений завершен: ${imageAnalysisStats.completed_count}`,
          `Анализ изображений ошибок: ${imageAnalysisStats.failed_count}`,
          `LLM-классификация ожидает: ${classificationStats.pending_count}`,
          `LLM-классификация выполняется: ${classificationStats.running_count}`,
          `LLM-классификация завершена: ${classificationStats.completed_count}`,
          `LLM-классификация ошибок: ${classificationStats.failed_count}`,
          `Производных артефактов: ${preprocessingStats.artifact_count}`,
          `OCR/ASR артефактов: ${mediaProcessingStats.artifact_count}`,
          `Image артефактов: ${imageAnalysisStats.artifact_count}`,
          `Embeddings: ${embeddingStats.embedding_count}`,
          `Proposed records: ${classificationStats.record_count}`,
          `Proposed entities: ${classificationStats.entity_count}`,
          `Proposed relations: ${classificationStats.relation_count}`,
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

  bot.command("analyze_images", async (ctx) => {
    const { limit, rest } = parseLimitPrefix(ctx.match, 3, 20);
    const reprocess = rest === "reprocess" || rest === "--reprocess";
    const summary = await imageAnalysisService.enqueueAndProcess(
      `telegram-${ctx.from?.id}`,
      limit,
      reprocess,
    );
    await ctx.reply(formatImageAnalysisSummary(summary));
  });

  bot.command("classify", async (ctx) => {
    const { limit, rest } = parseLimitPrefix(ctx.match, 3, 20);
    const reclassify = rest === "reclassify" || rest === "--reclassify";
    const summary = await classificationService.enqueueAndProcess(
      `telegram-${ctx.from?.id}`,
      limit,
      reclassify,
    );
    await ctx.reply(formatClassificationSummary(summary));
  });

  bot.command("proposals", async (ctx) => {
    const { limit } = parseLimitPrefix(ctx.match, 5, config.SEARCH_RESULT_LIMIT);
    const proposals = await classificationService.recentProposals(limit);
    if (proposals.length === 0) {
      await ctx.reply("Предложенных records пока нет.");
      return;
    }
    const text = proposals.map(formatProposal).join("\n\n");
    for (const chunk of splitTelegramMessage(text)) {
      await ctx.reply(chunk);
    }
  });

  bot.command("inbox", async (ctx) => {
    const { limit } = parseLimitPrefix(ctx.match, 3, 10);
    const proposals = await reviewService.pendingInbox(limit);
    if (proposals.length === 0) {
      await ctx.reply("Inbox пуст.");
      return;
    }
    for (const proposal of proposals) {
      const sent = await ctx.reply(formatInboxProposal(proposal), {
        reply_markup: inboxKeyboard(proposal.id),
      });
      if (proposal.clarificationRequestId) {
        pendingClarificationReplies.set(sent.message_id, proposal.clarificationRequestId);
      }
    }
  });

  bot.callbackQuery(/^inbox:(accept|correct|reject|ignore):([0-9a-f-]{36})$/, async (ctx) => {
    const action = ctx.match[1] as "accept" | "correct" | "reject" | "ignore";
    const recordId = ctx.match[2]!;
    const telegramUserId = ctx.from.id;
    if (action === "correct") {
      pendingCorrections.set(telegramUserId, recordId);
      await ctx.answerCallbackQuery();
      await ctx.reply("Отправь исправленный заголовок или описание reply-сообщением.");
      return;
    }
    const changed = await reviewService.act(recordId, action, telegramUserId);
    await ctx.answerCallbackQuery(changed ? "Готово" : "Уже обработано");
    await ctx.editMessageText(changed ? "Предложение обработано." : "Предложение уже не активно.");
  });

  async function searchCommand(ctx: BotContext, command: "/search" | "/find") {
    const { limit, rest: query } = parseLimitPrefix(
      typeof ctx.match === "string" ? ctx.match : "",
      config.SEARCH_RESULT_LIMIT,
      config.SEARCH_RESULT_LIMIT,
    );
    if (!query) {
      await ctx.reply(`Использование: ${command} запрос`);
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
  }

  bot.command("search", async (ctx) => {
    await searchCommand(ctx, "/search");
  });

  bot.command("find", async (ctx) => {
    await searchCommand(ctx, "/find");
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
    if (ctx.message?.reply_to_message && ctx.from?.id) {
      const pendingRecordId = pendingCorrections.get(ctx.from.id);
      const correctionText = "text" in ctx.message ? ctx.message.text?.trim() : undefined;
      if (pendingRecordId && correctionText) {
        pendingCorrections.delete(ctx.from.id);
        const changed = await reviewService.correctedAccept(
          pendingRecordId,
          correctionText,
          ctx.from.id,
        );
        await ctx.reply(changed ? "Исправление принято." : "Предложение уже не активно.");
        return;
      }
      const clarificationRequestId = pendingClarificationReplies.get(
        ctx.message.reply_to_message.message_id,
      );
      if (clarificationRequestId && correctionText) {
        pendingClarificationReplies.delete(ctx.message.reply_to_message.message_id);
        const changed = await reviewService.answerClarification(
          clarificationRequestId,
          correctionText,
          ctx.from.id,
          ctx.message.message_id,
        );
        await ctx.reply(changed ? "Ответ сохранен. Источник отправлен на повторную классификацию." : "Вопрос уже не активен.");
        return;
      }
    }
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

function inboxKeyboard(recordId: string) {
  return new InlineKeyboard()
    .text("✅ Верно", `inbox:accept:${recordId}`)
    .text("✏️ Исправить", `inbox:correct:${recordId}`)
    .row()
    .text("❌ Неверно", `inbox:reject:${recordId}`)
    .text("🗑 Игнорировать", `inbox:ignore:${recordId}`);
}
