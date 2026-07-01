import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";

export interface ClassificationSource {
  messageId: string;
  text: string;
  contentHash: string;
  parts: Array<{ kind: string; sourceId: string; length: number }>;
}

interface SourceRow extends Record<string, unknown> {
  message_id: string;
  telegram_date: Date | string;
  message_type: string;
  message_text: string | null;
  normalized_text: unknown;
  attachment_context: unknown;
}

export async function buildClassificationSource(
  db: Database,
  messageId: string,
  maxChars: number,
): Promise<ClassificationSource | undefined> {
  const result = await db.execute<SourceRow>(sql`
    select
      m.id as message_id,
      m.telegram_date,
      m.message_type,
      m.current_text as message_text,
      (
        select da.content
        from derived_artifacts da
        where da.source_kind = 'message'
          and da.source_id = m.id
          and da.artifact_type = 'normalized_text'
        order by da.updated_at desc
        limit 1
      ) as normalized_text,
      (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'attachmentId', a.id,
            'fileName', a.original_file_name,
            'mimeType', a.mime_type,
            'artifactType', da.artifact_type,
            'content', da.content
          )
          order by a.created_at asc, da.artifact_type asc
        ), '[]'::jsonb)
        from attachments a
        left join derived_artifacts da
          on da.source_kind = 'attachment'
          and da.source_id = a.id
          and da.artifact_type in ('ocr_text', 'transcript', 'image_description')
        where a.message_id = m.id
      ) as attachment_context
    from messages m
    where m.id = ${messageId}
    limit 1
  `);

  const row = result.rows[0];
  if (!row) return undefined;

  const chunks: string[] = [];
  const parts: ClassificationSource["parts"] = [];
  addPart(
    chunks,
    parts,
    "message_meta",
    row.message_id,
    [`date: ${String(row.telegram_date)}`, `type: ${row.message_type}`].join("\n"),
  );

  const normalized = textFromContent(row.normalized_text);
  addPart(chunks, parts, "normalized_text", row.message_id, normalized);
  if (!normalized) addPart(chunks, parts, "message_text", row.message_id, row.message_text);

  for (const attachment of attachmentContext(row.attachment_context)) {
    addPart(
      chunks,
      parts,
      "attachment",
      attachment.attachmentId,
      [
        attachment.fileName ? `file: ${attachment.fileName}` : undefined,
        attachment.mimeType ? `mime: ${attachment.mimeType}` : undefined,
        attachment.artifactType
          ? `${attachment.artifactType}: ${textFromContent(attachment.content)}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const text = truncatePreservingWords(chunks.join("\n\n"), maxChars);
  return {
    messageId: row.message_id,
    text,
    contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    parts,
  };
}

function addPart(
  chunks: string[],
  parts: ClassificationSource["parts"],
  kind: string,
  sourceId: string,
  value: string | null | undefined,
) {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return;
  chunks.push(text);
  parts.push({ kind, sourceId, length: text.length });
}

function textFromContent(content: unknown) {
  if (typeof content !== "object" || content === null) return undefined;
  const candidate = content as Record<string, unknown>;
  const text = candidate.text ?? candidate.description;
  return typeof text === "string" ? text : undefined;
}

function attachmentContext(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(isAttachmentContext);
}

function isAttachmentContext(value: unknown): value is {
  attachmentId: string;
  fileName: string | null;
  mimeType: string | null;
  artifactType: string | null;
  content: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.attachmentId === "string";
}

function truncatePreservingWords(text: string, maxChars: number) {
  const compact = text.replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length <= maxChars) return compact;
  const boundary = compact.lastIndexOf(" ", maxChars);
  return compact.slice(0, boundary > maxChars * 0.8 ? boundary : maxChars).trim();
}
