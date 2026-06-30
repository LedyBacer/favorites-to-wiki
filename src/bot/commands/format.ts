import type { Attachment, Message } from "../../db/schema.js";

export function shortText(text: string | null | undefined, length = 160) {
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}...` : compact;
}

export function telegramMessageLink(chatId: number, messageId: number) {
  const chat = String(chatId);
  if (chat.startsWith("-100")) {
    return `https://t.me/c/${chat.slice(4)}/${messageId}`;
  }
  return undefined;
}

export function formatTelegramDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value).slice(0, 16).replace("T", " ")
    : date.toISOString().slice(0, 16).replace("T", " ");
}

export function formatSavedAck(type: string, attachmentCount: number) {
  const attachmentPart = attachmentCount > 0 ? ` · ${attachmentCount} влож.` : "";
  return `Сохранено · ${type}${attachmentPart}`;
}

export function formatAttachmentSummary(
  attachments: Pick<Attachment, "originalFileName" | "mimeType">[],
) {
  if (attachments.length === 0) return "";
  const names = attachments
    .map((attachment) => attachment.originalFileName || attachment.mimeType)
    .filter(Boolean)
    .slice(0, 3);
  const suffix = attachments.length > names.length ? ` +${attachments.length - names.length}` : "";
  return names.length > 0 ? `${names.join(", ")}${suffix}` : `${attachments.length} влож.`;
}

export function formatRecentMessage(message: Message & { attachments?: Attachment[] }) {
  const link = telegramMessageLink(message.telegramChatId, message.telegramMessageId);
  const date = formatTelegramDate(message.telegramDate);
  const attachmentCount = message.attachments?.length ?? 0;
  const attachmentSummary = formatAttachmentSummary(message.attachments ?? []);
  const parts = [
    `${date} · ${message.messageType}`,
    shortText(message.currentText),
    attachmentSummary,
    attachmentCount && !attachmentSummary ? `${attachmentCount} влож.` : "",
    link ?? "",
  ];
  return parts.filter(Boolean).join("\n");
}
