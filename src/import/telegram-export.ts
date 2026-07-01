import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SaveMessageInput } from "../domain/messages/types.js";

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
}

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
    const attachment = message.attachmentPath
      ? {
          telegramFileId: exportAttachmentId(message.attachmentPath),
          telegramFileUniqueId: exportAttachmentId(message.attachmentPath),
          originalFileName: basename(message.attachmentPath),
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
    };
  });
}

function parseExportMessage(
  message: TelegramExportMessage,
): ParsedTelegramExportMessage | undefined {
  const exportType = message.type ?? "message";
  if (exportType !== "message") return undefined;

  const text = exportText(message);
  const attachmentPath = message.file ?? message.photo;
  const messageType = exportMessageType(message, text, attachmentPath);

  return {
    id: message.id,
    exportType,
    messageType,
    date: exportDate(message.date_unixtime, message.date),
    editedDate: exportDate(message.edited_unixtime, message.edited),
    text,
    attachmentPath,
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
    `Edited messages: ${summary.editedMessages}`,
    `Forwarded messages: ${summary.forwardedMessages}`,
    `Reply messages: ${summary.replyMessages}`,
    summary.unsupportedTypes.length
      ? `Unsupported types: ${summary.unsupportedTypes.join(", ")}`
      : "Unsupported types: none",
  ];
  console.log(lines.filter(Boolean).join("\n"));
}

function readJsonFile(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function main(argv: string[]) {
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
    console.error("Database import is not implemented yet. Use --dry-run to inspect the export.");
    process.exitCode = 1;
    return;
  }

  printDryRunSummary(summarizeTelegramDesktopExport(readJsonFile(exportPath)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
