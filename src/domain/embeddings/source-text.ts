import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";

export interface EmbeddingSourceText {
  messageId: string;
  text: string;
  contentHash: string;
  parts: Array<{ kind: string; sourceId: string; length: number }>;
}

interface SourceRow extends Record<string, unknown> {
  message_id: string;
  message_text: string | null;
  normalized_text: unknown;
  attachment_texts: unknown;
  attachment_names: string | null;
}

export async function buildMessageEmbeddingSourceText(
  db: Database,
  messageId: string,
  maxChars: number,
): Promise<EmbeddingSourceText | undefined> {
  const result = await db.execute<SourceRow>(sql`
    select
      m.id as message_id,
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
            'artifactType', da.artifact_type,
            'content', da.content
          )
          order by a.created_at asc, da.artifact_type asc
        ), '[]'::jsonb)
        from attachments a
        join derived_artifacts da
          on da.source_kind = 'attachment'
          and da.source_id = a.id
          and da.artifact_type in ('ocr_text', 'transcript')
        where a.message_id = m.id
      ) as attachment_texts,
      (
        select string_agg(a.original_file_name, E'\n' order by a.created_at asc)
        from attachments a
        where a.message_id = m.id
          and a.original_file_name is not null
      ) as attachment_names
    from messages m
    where m.id = ${messageId}
    limit 1
  `);

  const row = result.rows[0];
  if (!row) return undefined;

  const parts: EmbeddingSourceText["parts"] = [];
  const chunks: string[] = [];

  const normalized = textFromContent(row.normalized_text);
  addPart(chunks, parts, "normalized_text", row.message_id, normalized);
  if (!normalized) addPart(chunks, parts, "message_text", row.message_id, row.message_text);
  addPart(chunks, parts, "attachment_names", row.message_id, row.attachment_names);

  for (const attachmentText of attachmentTexts(row.attachment_texts)) {
    addPart(
      chunks,
      parts,
      attachmentText.artifactType,
      attachmentText.attachmentId,
      textFromContent(attachmentText.content),
    );
  }

  const text = truncatePreservingWords(chunks.join("\n\n"), maxChars);
  return {
    messageId: row.message_id,
    text,
    contentHash: hashEmbeddingSourceText(text),
    parts,
  };
}

export function hashEmbeddingSourceText(text: string) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function addPart(
  chunks: string[],
  parts: EmbeddingSourceText["parts"],
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
  const value = (content as { text?: unknown }).text;
  return typeof value === "string" ? value : undefined;
}

function attachmentTexts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter(isAttachmentText);
}

function isAttachmentText(value: unknown): value is {
  attachmentId: string;
  artifactType: string;
  content: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.attachmentId === "string" &&
    typeof candidate.artifactType === "string" &&
    (candidate.artifactType === "ocr_text" || candidate.artifactType === "transcript")
  );
}

function truncatePreservingWords(text: string, maxChars: number) {
  const compact = text.replace(/\n{3,}/g, "\n\n").trim();
  if (compact.length <= maxChars) return compact;
  const boundary = compact.lastIndexOf(" ", maxChars);
  return compact.slice(0, boundary > maxChars * 0.8 ? boundary : maxChars).trim();
}
