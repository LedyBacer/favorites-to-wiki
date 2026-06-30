import path from "node:path";

const extensionByMime = new Map<string, string>([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["video/mp4", ".mp4"],
  ["audio/ogg", ".ogg"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
]);

export function sanitizeFileName(name: string | undefined, fallback: string) {
  const base = path.basename(name ?? fallback);
  const sanitized = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : fallback;
}

export function buildAttachmentRelativePath(input: {
  uniqueFileId: string;
  originalFileName?: string | undefined;
  mimeType?: string | undefined;
}) {
  const safeUniqueId = sanitizeFileName(input.uniqueFileId, "file");
  const extFromName = path.extname(input.originalFileName ?? "");
  const extension = extFromName || extensionByMime.get(input.mimeType ?? "") || ".bin";
  const fileName = sanitizeFileName(input.originalFileName, safeUniqueId);
  const stem = path.basename(fileName, path.extname(fileName));
  const prefix = safeUniqueId.slice(0, 2) || "xx";
  return path.join(prefix, `${safeUniqueId}-${stem}${extension}`);
}
