import type { Attachment, Message } from "../../db/schema.js";
import type { SemanticSearchResult } from "../../domain/embeddings/embedding-service.js";
import type { LlmClassificationService } from "../../domain/llm/llm-classification-service.js";
import type { SearchResult } from "../../search/search-service.js";

export const TELEGRAM_MESSAGE_SAFE_LIMIT = 3900;

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

export function parseLimitPrefix(
  input: string,
  defaultLimit: number,
  maxLimit: number,
): { limit: number; rest: string } {
  const trimmed = input.trim();
  const match = /^(\d+)(?:\s+|$)(.*)$/s.exec(trimmed);
  if (!match) return { limit: defaultLimit, rest: trimmed };

  const requested = Number(match[1]);
  return {
    limit: Number.isSafeInteger(requested)
      ? Math.min(Math.max(requested, 1), maxLimit)
      : defaultLimit,
    rest: match[2]?.trim() ?? "",
  };
}

export function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_SAFE_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const paragraphBreak = remaining.lastIndexOf("\n\n", limit);
    const lineBreak = remaining.lastIndexOf("\n", limit);
    const wordBreak = remaining.lastIndexOf(" ", limit);
    const splitAt =
      paragraphBreak > limit * 0.3
        ? paragraphBreak
        : lineBreak > limit * 0.5
          ? lineBreak
          : wordBreak > limit * 0.5
            ? wordBreak
            : limit;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function searchSnippet(text: string | null | undefined, query: string, length = 220) {
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= length) return compact;

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  const lower = compact.toLowerCase();
  const firstMatch = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (firstMatch === undefined) return shortText(compact, length);

  const start = Math.max(0, firstMatch - Math.floor(length / 3));
  const end = Math.min(compact.length, start + length);
  return `${start > 0 ? "... " : ""}${compact.slice(start, end).trim()}${
    end < compact.length ? " ..." : ""
  }`;
}

export function formatSearchResult(result: SearchResult, query: string) {
  const link = telegramMessageLink(result.telegramChatId, result.telegramMessageId);
  return [
    `${formatTelegramDate(result.telegramDate)} · ${result.messageType}`,
    searchSnippet(result.currentText, query),
    result.attachmentNames ? `Файлы: ${result.attachmentNames}` : "",
    link ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatSemanticSearchResult(result: SemanticSearchResult, query: string) {
  const link = telegramMessageLink(result.telegramChatId, result.telegramMessageId);
  return [
    `${formatTelegramDate(result.telegramDate)} · ${result.messageType} · ${result.similarity.toFixed(3)}`,
    searchSnippet(result.currentText, query),
    result.attachmentNames ? `Файлы: ${result.attachmentNames}` : "",
    link ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatProposal(
  proposal: Awaited<ReturnType<LlmClassificationService["recentProposals"]>>[number],
) {
  return [
    `${formatTelegramDate(proposal.created_at)} · ${proposal.type}`,
    proposal.title ?? "",
    shortText(proposal.body, 260),
  ]
    .filter(Boolean)
    .join("\n");
}
