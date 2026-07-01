import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDatabase, type Database } from "../db/client.js";
import { attachments } from "../db/schema.js";
import { MessageService } from "../domain/messages/message-service.js";
import type { SaveMessageInput } from "../domain/messages/types.js";
import { LocalStorage } from "../storage/local-storage.js";

const textPartSchema = z.union([
  z.string(),
  z
    .object({
      text: z.string().optional(),
      type: z.string().optional(),
    })
    .passthrough(),
]);

const exportMessageSchema = z
  .object({
    id: z.number().int(),
    type: z.string().optional(),
    date: z.string().optional(),
    date_unixtime: z.union([z.string(), z.number()]).optional(),
    edited: z.string().optional(),
    edited_unixtime: z.union([z.string(), z.number()]).optional(),
    from_id: z.union([z.string(), z.number()]).optional(),
    text: z.union([z.string(), z.array(textPartSchema)]).optional(),
    text_entities: z.array(textPartSchema).optional(),
    file: z.string().optional(),
    photo: z.string().optional(),
    media_type: z.string().optional(),
    mime_type: z.string().optional(),
    forwarded_from: z.string().optional(),
    reply_to_message_id: z.number().int().optional(),
  })
  .passthrough();

const exportSchema = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    messages: z.array(exportMessageSchema),
  })
  .passthrough();

export type TelegramExportMessageType =
  "text" | "photo" | "document" | "voice" | "video" | "unknown";

export interface ParsedTelegramExportMessage {
  id: number;
  exportType: string;
  messageType: TelegramExportMessageType;
  date?: Date | undefined;
  editedDate?: Date | undefined;
  text?: string | undefined;
  attachmentPath?: string | undefined;
  attachmentUnavailableReason?: string | undefined;
  attachmentUnavailableSource?: string | undefined;
  mimeType?: string | undefined;
  forwardedFrom?: string | undefined;
  replyToMessageId?: number | undefined;
}

export interface TelegramExportDryRunSummary {
  chatName?: string | undefined;
  totalMessages: number;
  supportedMessages: number;
  unsupportedMessages: number;
  textMessages: number;
  attachmentMessages: number;
  unavailableAttachments: number;
  editedMessages: number;
  forwardedMessages: number;
  replyMessages: number;
  unsupportedTypes: string[];
}

export interface TelegramExportImportOptions {
  telegramChatId: number;
  telegramUserId: number;
  sourceFilePath?: string | undefined;
  sourceName?: string | undefined;
}

export interface MappedTelegramExportMessage {
  sourceMessageId: number;
  input: SaveMessageInput;
  attachmentSourcePath?: string | undefined;
  attachmentUnavailableReason?: string | undefined;
}

export interface TelegramExportImportSummary {
  scanned: number;
  saved: number;
  created: number;
  versionsCreated: number;
  attachments: number;
  unavailableAttachments: number;
  attachmentsStored: number;
  attachmentFailures: number;
}

interface TelegramExportImportRuntimeOptions {
  databaseUrl: string;
  storageRoot: string;
  maxAttachmentBytes: number;
  sourceFilePath: string;
}

const importEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  STORAGE_ROOT: z.string().min(1).default("./data/storage"),
  MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
});

type TelegramExport = z.infer<typeof exportSchema>;
type TelegramExportMessage = z.infer<typeof exportMessageSchema>;

export function parseTelegramDesktopExportJson(input: unknown): ParsedTelegramExportMessage[] {
  const parsed = exportSchema.parse(input);
  return parsed.messages
    .map(parseExportMessage)
    .filter((message): message is ParsedTelegramExportMessage => message !== undefined);
}

export function summarizeTelegramDesktopExport(input: unknown): TelegramExportDryRunSummary {
  const parsed = exportSchema.parse(input);
  const supportedMessages = parseTelegramDesktopExportJson(parsed);
  const unsupportedTypes = unsupportedMessageTypes(parsed);

  return {
    chatName: parsed.name,
    totalMessages: parsed.messages.length,
    supportedMessages: supportedMessages.length,
    unsupportedMessages: parsed.messages.length - supportedMessages.length,
    textMessages: supportedMessages.filter((message) => message.messageType === "text").length,
    attachmentMessages: supportedMessages.filter((message) => message.attachmentPath).length,
    unavailableAttachments: supportedMessages.filter(
      (message) => message.attachmentUnavailableReason,
    ).length,
    editedMessages: supportedMessages.filter((message) => message.editedDate).length,
    forwardedMessages: supportedMessages.filter((message) => message.forwardedFrom).length,
    replyMessages: supportedMessages.filter((message) => message.replyToMessageId).length,
    unsupportedTypes,
  };
}

export function mapTelegramDesktopExportToSaveInputs(
  input: unknown,
  options: TelegramExportImportOptions,
): MappedTelegramExportMessage[] {
  const parsed = exportSchema.parse(input);
  const sourceName = options.sourceName ?? parsed.name;

  return parseTelegramDesktopExportJson(parsed).map((message) => {
    const attachmentIdSource = message.attachmentPath ?? message.attachmentUnavailableSource;
    const attachment = attachmentIdSource
      ? {
          telegramFileId: exportAttachmentId(attachmentIdSource),
          telegramFileUniqueId: exportAttachmentId(attachmentIdSource),
          originalFileName: message.attachmentPath ? basename(message.attachmentPath) : undefined,
          mimeType: message.mimeType,
        }
      : undefined;

    return {
      sourceMessageId: message.id,
      input: {
        telegramChatId: options.telegramChatId,
        telegramMessageId: message.id,
        telegramUserId: options.telegramUserId,
        telegramDate: message.date ?? new Date(0),
        text: message.text,
        messageType: message.messageType,
        forward: message.forwardedFrom
          ? {
              originType: "telegram_desktop_export",
              senderName: message.forwardedFrom,
            }
          : undefined,
        replyToTelegramMessageId: message.replyToMessageId,
        telegramEditDate: message.editedDate,
        metadata: exportMetadata(message, parsed, options, sourceName),
        attachments: attachment ? [attachment] : [],
      },
      attachmentSourcePath: message.attachmentPath,
      attachmentUnavailableReason: message.attachmentUnavailableReason,
    };
  });
}

export function deriveTelegramDesktopExportIdentity(input: unknown) {
  const exportData = exportSchema.parse(input);
  const sourceKey = JSON.stringify({
    id: exportData.id,
    name: exportData.name,
    type: exportData.type,
  });
  const hash = createHash("sha256").update(sourceKey).digest("hex");
  const chatId = -Number.parseInt(hash.slice(0, 12), 16);
  const userId = Number.parseInt(hash.slice(12, 24), 16);
  return { telegramChatId: chatId, telegramUserId: userId };
}

export async function importTelegramDesktopExport(
  input: unknown,
  options: TelegramExportImportOptions & {
    db: Database;
    storage: LocalStorage;
    exportDir: string;
    maxAttachmentBytes: number;
  },
): Promise<TelegramExportImportSummary> {
  const mapped = mapTelegramDesktopExportToSaveInputs(input, options);
  const messageService = new MessageService(options.db);
  const summary: TelegramExportImportSummary = {
    scanned: mapped.length,
    saved: 0,
    created: 0,
    versionsCreated: 0,
    attachments: mapped.filter((message) => message.attachmentSourcePath).length,
    unavailableAttachments: mapped.filter((message) => message.attachmentUnavailableReason).length,
    attachmentsStored: 0,
    attachmentFailures: 0,
  };

  for (const message of mapped) {
    const result = await messageService.saveTelegramMessage(message.input);
    summary.saved += 1;
    if (result.created) summary.created += 1;
    if (result.versionCreated) summary.versionsCreated += 1;

    if (message.attachmentSourcePath && message.input.attachments[0]) {
      try {
        const stored = await options.storage.storeLocalFile({
          sourcePath: resolve(options.exportDir, message.attachmentSourcePath),
          uniqueFileId: message.input.attachments[0].telegramFileUniqueId,
          originalFileName: message.input.attachments[0].originalFileName,
          mimeType: message.input.attachments[0].mimeType,
          maxBytes: options.maxAttachmentBytes,
        });
        await markImportedAttachmentDownloaded(
          options.db,
          result.messageId,
          message.input.attachments[0].telegramFileUniqueId,
          stored,
        );
        summary.attachmentsStored += 1;
      } catch (error) {
        await markImportedAttachmentFailed(
          options.db,
          result.messageId,
          message.input.attachments[0].telegramFileUniqueId,
          error,
        );
        summary.attachmentFailures += 1;
      }
    } else if (message.attachmentUnavailableReason && message.input.attachments[0]) {
      await markImportedAttachmentSkippedTooLarge(
        options.db,
        result.messageId,
        message.input.attachments[0].telegramFileUniqueId,
        message.attachmentUnavailableReason,
      );
    }
  }

  return summary;
}

function parseExportMessage(
  message: TelegramExportMessage,
): ParsedTelegramExportMessage | undefined {
  const exportType = message.type ?? "message";
  if (exportType !== "message") return undefined;

  const text = exportText(message);
  const attachment = exportAttachment(message);
  const messageType = exportMessageType(message, text, attachment.path);

  return {
    id: message.id,
    exportType,
    messageType,
    date: exportDate(message.date_unixtime, message.date),
    editedDate: exportDate(message.edited_unixtime, message.edited),
    text,
    attachmentPath: attachment.path,
    attachmentUnavailableReason: attachment.unavailableReason,
    attachmentUnavailableSource: attachment.unavailableSource,
    mimeType: message.mime_type,
    forwardedFrom: message.forwarded_from,
    replyToMessageId: message.reply_to_message_id,
  };
}

function exportText(message: TelegramExportMessage) {
  const source = message.text ?? message.text_entities;
  if (!source) return undefined;
  if (typeof source === "string") return source.trim() || undefined;

  const text = source
    .map((part) => (typeof part === "string" ? part : (part.text ?? "")))
    .join("")
    .trim();
  return text || undefined;
}

function exportMessageType(
  message: TelegramExportMessage,
  text: string | undefined,
  attachmentPath: string | undefined,
): TelegramExportMessageType {
  if (message.photo || message.media_type === "photo") return "photo";
  if (message.media_type === "voice_message" || message.mime_type?.startsWith("audio/")) {
    return "voice";
  }
  if (message.media_type === "video_file" || message.mime_type?.startsWith("video/")) {
    return "video";
  }
  if (message.file || attachmentPath) return "document";
  return text ? "text" : "unknown";
}

function exportAttachment(message: TelegramExportMessage) {
  const path = message.file ?? message.photo;
  if (!path) return {};
  if (path.startsWith("(") && path.endsWith(")")) {
    return { unavailableReason: path.slice(1, -1), unavailableSource: path };
  }
  return { path };
}

function exportDate(unixTime: string | number | undefined, fallback: string | undefined) {
  if (unixTime !== undefined) {
    const date = new Date(Number(unixTime) * 1000);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (!fallback) return undefined;
  const date = new Date(fallback);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function exportAttachmentId(path: string) {
  return `telegram-export:${createHash("sha256").update(path).digest("hex")}`;
}

function exportMetadata(
  message: ParsedTelegramExportMessage,
  exportData: TelegramExport,
  options: TelegramExportImportOptions,
  sourceName: string | undefined,
): Record<string, unknown> {
  return {
    source: "telegram_desktop_export",
    sourceChatName: sourceName,
    sourceChatType: exportData.type,
    sourceChatId: exportData.id,
    sourceFilePath: options.sourceFilePath,
    sourceMessageId: message.id,
    sourceMessageType: message.exportType,
    sourceAttachmentPath: message.attachmentPath,
    sourceAttachmentUnavailableReason: message.attachmentUnavailableReason,
  };
}

function unsupportedMessageTypes(exportData: TelegramExport) {
  return [
    ...new Set(
      exportData.messages
        .map((message) => message.type ?? "message")
        .filter((type) => type !== "message"),
    ),
  ].sort();
}

function printDryRunSummary(summary: TelegramExportDryRunSummary) {
  const lines = [
    "Telegram export dry run",
    summary.chatName ? `Chat: ${summary.chatName}` : "",
    `Total messages: ${summary.totalMessages}`,
    `Supported messages: ${summary.supportedMessages}`,
    `Unsupported messages: ${summary.unsupportedMessages}`,
    `Text messages: ${summary.textMessages}`,
    `Attachment messages: ${summary.attachmentMessages}`,
    `Unavailable attachments: ${summary.unavailableAttachments}`,
    `Edited messages: ${summary.editedMessages}`,
    `Forwarded messages: ${summary.forwardedMessages}`,
    `Reply messages: ${summary.replyMessages}`,
    summary.unsupportedTypes.length
      ? `Unsupported types: ${summary.unsupportedTypes.join(", ")}`
      : "Unsupported types: none",
  ];
  console.log(lines.filter(Boolean).join("\n"));
}

function printImportSummary(summary: TelegramExportImportSummary) {
  console.log(
    [
      "Telegram export import complete",
      `Scanned messages: ${summary.scanned}`,
      `Saved messages: ${summary.saved}`,
      `Created messages: ${summary.created}`,
      `Versions created: ${summary.versionsCreated}`,
      `Attachments: ${summary.attachments}`,
      `Unavailable attachments: ${summary.unavailableAttachments}`,
      `Attachments stored: ${summary.attachmentsStored}`,
      `Attachment failures: ${summary.attachmentFailures}`,
    ].join("\n"),
  );
}

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function loadImportRuntimeOptions(sourceFilePath: string): TelegramExportImportRuntimeOptions {
  const env = importEnvSchema.parse(process.env);
  return {
    databaseUrl: env.DATABASE_URL,
    storageRoot: env.STORAGE_ROOT,
    maxAttachmentBytes: env.MAX_ATTACHMENT_BYTES,
    sourceFilePath,
  };
}

async function runImport(input: unknown, options: TelegramExportImportRuntimeOptions) {
  const parsed = exportSchema.parse(input);
  const identity = deriveTelegramDesktopExportIdentity(parsed);
  const database = createDatabase(options.databaseUrl);
  const storage = new LocalStorage(options.storageRoot);

  try {
    const summary = await importTelegramDesktopExport(parsed, {
      ...identity,
      db: database.db,
      storage,
      exportDir: dirname(options.sourceFilePath),
      maxAttachmentBytes: options.maxAttachmentBytes,
      sourceFilePath: options.sourceFilePath,
    });
    printImportSummary(summary);
  } finally {
    await database.close();
  }
}

async function main(argv: string[]) {
  const [exportPath, ...flags] = argv;
  const dryRun = flags.includes("--dry-run");

  if (!exportPath) {
    console.error("Usage: npm run import:telegram -- /path/to/result.json --dry-run");
    process.exitCode = 1;
    return;
  }
  if (!existsSync(exportPath)) {
    console.error(`Telegram export file does not exist: ${exportPath}`);
    process.exitCode = 1;
    return;
  }
  if (!dryRun) {
    await runImport(readJsonFile(exportPath), loadImportRuntimeOptions(resolve(exportPath)));
    return;
  }

  printDryRunSummary(summarizeTelegramDesktopExport(readJsonFile(exportPath)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}

async function markImportedAttachmentDownloaded(
  db: Database,
  messageId: string,
  telegramFileUniqueId: string,
  stored: { relativePath: string; sha256: string; sizeBytes: number },
) {
  await db
    .update(attachments)
    .set({
      localPath: stored.relativePath,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      downloadStatus: "downloaded",
      downloadAttempts: 0,
      lastDownloadAttemptAt: new Date(),
      nextRetryAt: null,
      error: null,
    })
    .where(
      and(
        eq(attachments.messageId, messageId),
        eq(attachments.telegramFileUniqueId, telegramFileUniqueId),
      ),
    );
}

async function markImportedAttachmentFailed(
  db: Database,
  messageId: string,
  telegramFileUniqueId: string,
  error: unknown,
) {
  await db
    .update(attachments)
    .set({
      downloadStatus: "failed",
      downloadAttempts: 1,
      lastDownloadAttemptAt: new Date(),
      nextRetryAt: null,
      error: error instanceof Error ? error.message : String(error),
    })
    .where(
      and(
        eq(attachments.messageId, messageId),
        eq(attachments.telegramFileUniqueId, telegramFileUniqueId),
      ),
    );
}

async function markImportedAttachmentSkippedTooLarge(
  db: Database,
  messageId: string,
  telegramFileUniqueId: string,
  reason: string,
) {
  await db
    .update(attachments)
    .set({
      downloadStatus: "skipped_too_large",
      downloadAttempts: 0,
      lastDownloadAttemptAt: new Date(),
      nextRetryAt: null,
      error: reason,
    })
    .where(
      and(
        eq(attachments.messageId, messageId),
        eq(attachments.telegramFileUniqueId, telegramFileUniqueId),
      ),
    );
}
