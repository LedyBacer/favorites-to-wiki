import type { Message } from "../../db/schema.js";

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

export function formatSavedAck(type: string, attachmentCount: number) {
  const attachmentPart = attachmentCount > 0 ? ` · ${attachmentCount} влож.` : "";
  return `Сохранено · ${type}${attachmentPart}`;
}

export function formatRecentMessage(message: Message & { attachments?: unknown[] }) {
  const link = telegramMessageLink(message.telegramChatId, message.telegramMessageId);
  const date = message.telegramDate.toISOString().slice(0, 16).replace("T", " ");
  const attachmentCount = message.attachments?.length ?? 0;
  const parts = [
    `${date} · ${message.messageType}`,
    shortText(message.currentText),
    attachmentCount ? `${attachmentCount} влож.` : "",
    link ?? "",
  ];
  return parts.filter(Boolean).join("\n");
}
