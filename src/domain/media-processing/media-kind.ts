import path from "node:path";
import type { Attachment } from "../../db/schema.js";

const OCR_EXTENSIONS = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const ASR_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);

export function isOcrCandidate(
  attachment: Pick<Attachment, "downloadStatus" | "localPath" | "mimeType" | "originalFileName">,
) {
  if (attachment.downloadStatus !== "downloaded" || !attachment.localPath) return false;
  const mimeType = attachment.mimeType?.toLowerCase() ?? "";
  if (mimeType.startsWith("image/")) return true;
  return OCR_EXTENSIONS.has(extensionForAttachment(attachment));
}

export function isAsrCandidate(
  attachment: Pick<Attachment, "downloadStatus" | "localPath" | "mimeType" | "originalFileName">,
) {
  if (attachment.downloadStatus !== "downloaded" || !attachment.localPath) return false;
  const mimeType = attachment.mimeType?.toLowerCase() ?? "";
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) return true;
  return ASR_EXTENSIONS.has(extensionForAttachment(attachment));
}

function extensionForAttachment(attachment: Pick<Attachment, "localPath" | "originalFileName">) {
  const name = attachment.originalFileName || attachment.localPath || "";
  return path.extname(name).toLowerCase();
}
