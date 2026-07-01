import { basename, extname } from "node:path";
import type { Attachment, Message } from "../../db/schema.js";

export interface NormalizedTextArtifact {
  text: string;
  length: number;
  wordCount: number;
  hasText: boolean;
}

export interface ExtractedMetadataArtifact {
  urls: Array<{ url: string; domain: string; scheme: string; path: string }>;
  domains: string[];
  hashtags: string[];
  mentions: string[];
  dates: Array<{ raw: string; normalized?: string | undefined; kind: "iso" | "numeric" }>;
}

export interface LinkPreviewArtifact {
  previews: Array<{
    url: string;
    domain: string;
    displayHost: string;
    path: string;
    scheme: string;
    fetched: false;
  }>;
}

export interface FileMetadataArtifact {
  originalFileName?: string | undefined;
  baseName?: string | undefined;
  extension?: string | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  localPath?: string | undefined;
  sha256?: string | undefined;
  downloadStatus: string;
  category: FileCategory;
}

export interface FilePreviewArtifact {
  label: string;
  category: FileCategory;
  extension?: string | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
  availableLocally: boolean;
  hashAvailable: boolean;
}

export type FileCategory =
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "text"
  | "archive"
  | "document"
  | "unknown";

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]}]+/giu;
const HASHTAG_PATTERN = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}_-]{2,64})/gu;
const MENTION_PATTERN = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,64})/g;
const ISO_DATE_PATTERN = /\b(20\d{2}|19\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/g;
const NUMERIC_DATE_PATTERN = /\b([0-2]?\d|3[01])[./](0?\d|1[0-2])[./]((?:20|19)?\d{2})\b/g;

export function normalizeText(text: string | null | undefined): NormalizedTextArtifact {
  const normalized = (text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return {
    text: normalized,
    length: normalized.length,
    wordCount: normalized ? normalized.split(/\s+/).length : 0,
    hasText: normalized.length > 0,
  };
}

export function extractMessageMetadata(text: string | null | undefined): ExtractedMetadataArtifact {
  const normalized = normalizeText(text).text;
  const urls = uniqueBy(
    [...normalized.matchAll(URL_PATTERN)]
      .map((match) => normalizeUrl(match[0]))
      .filter((url): url is NonNullable<ReturnType<typeof normalizeUrl>> => url !== undefined),
    (url) => url.url,
  );
  const hashtags = uniqueStrings(
    [...normalized.matchAll(HASHTAG_PATTERN)].map((match) => match[2]!.toLowerCase()),
  );
  const mentions = uniqueStrings(
    [...normalized.matchAll(MENTION_PATTERN)].map((match) => match[2]!.toLowerCase()),
  );
  const dates = uniqueBy([...extractIsoDates(normalized), ...extractNumericDates(normalized)], (d) =>
    `${d.kind}:${d.raw}`,
  );

  return {
    urls,
    domains: uniqueStrings(urls.map((url) => url.domain)),
    hashtags,
    mentions,
    dates,
  };
}

export function buildLinkPreview(metadata: ExtractedMetadataArtifact): LinkPreviewArtifact {
  return {
    previews: metadata.urls.map((url) => ({
      url: url.url,
      domain: url.domain,
      displayHost: url.domain,
      path: url.path,
      scheme: url.scheme,
      fetched: false,
    })),
  };
}

export function buildFileMetadata(attachment: Attachment): FileMetadataArtifact {
  const name = attachment.originalFileName ?? attachment.localPath ?? undefined;
  const extension = extensionFromName(name);
  const category = categorizeFile(attachment.mimeType ?? undefined, extension);
  return {
    originalFileName: attachment.originalFileName ?? undefined,
    baseName: name ? basename(name) : undefined,
    extension,
    mimeType: attachment.mimeType ?? undefined,
    sizeBytes: attachment.sizeBytes ?? undefined,
    localPath: attachment.localPath ?? undefined,
    sha256: attachment.sha256 ?? undefined,
    downloadStatus: attachment.downloadStatus,
    category,
  };
}

export function buildFilePreview(metadata: FileMetadataArtifact): FilePreviewArtifact {
  return {
    label: metadata.baseName ?? metadata.mimeType ?? metadata.category,
    category: metadata.category,
    extension: metadata.extension,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
    availableLocally: Boolean(metadata.localPath),
    hashAvailable: Boolean(metadata.sha256),
  };
}

export function messagePreprocessingSource(message: Message) {
  return {
    messageId: message.id,
    telegramChatId: message.telegramChatId,
    telegramMessageId: message.telegramMessageId,
    currentText: message.currentText,
    updatedAt: message.updatedAt,
  };
}

function normalizeUrl(value: string) {
  const trimmed = value.replace(/[.,;:!?]+$/u, "");
  const withScheme = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;
  try {
    const parsed = new URL(withScheme);
    if (!["http:", "https:"].includes(parsed.protocol)) return undefined;
    parsed.hash = "";
    return {
      url: parsed.toString(),
      domain: parsed.hostname.toLowerCase(),
      scheme: parsed.protocol.slice(0, -1),
      path: parsed.pathname,
    };
  } catch {
    return undefined;
  }
}

function* extractIsoDates(text: string) {
  for (const match of text.matchAll(ISO_DATE_PATTERN)) {
    yield { raw: match[0], normalized: match[0], kind: "iso" as const };
  }
}

function* extractNumericDates(text: string) {
  for (const match of text.matchAll(NUMERIC_DATE_PATTERN)) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const yearRaw = match[3]!;
    const year = yearRaw.length === 2 ? Number(`20${yearRaw}`) : Number(yearRaw);
    const normalized =
      day >= 1 && day <= 31 && month >= 1 && month <= 12
        ? `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
            .toString()
            .padStart(2, "0")}`
        : undefined;
    yield { raw: match[0], normalized, kind: "numeric" as const };
  }
}

function extensionFromName(name: string | undefined) {
  if (!name) return undefined;
  const extension = extname(name).toLowerCase().replace(/^\./u, "");
  return extension || undefined;
}

function categorizeFile(mimeType: string | undefined, extension: string | undefined): FileCategory {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType === "application/pdf" || extension === "pdf") return "pdf";
  if (mimeType?.startsWith("text/") || ["txt", "md", "csv", "json", "log"].includes(extension ?? "")) {
    return "text";
  }
  if (["zip", "gz", "tgz", "tar", "7z", "rar"].includes(extension ?? "")) return "archive";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods"].includes(extension ?? "")) {
    return "document";
  }
  return "unknown";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort();
}

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  const seen = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (!seen.has(id)) seen.set(id, value);
  }
  return [...seen.values()];
}
