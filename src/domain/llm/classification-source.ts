import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";

export interface ClassificationSource {
  sourceKind: "message" | "bundle";
  sourceId: string;
  messageId: string | null;
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
  sourceId: string,
  maxChars: number,
  sourceKind: "message" | "bundle" = "message",
): Promise<ClassificationSource | undefined> {
  if (sourceKind === "bundle") return buildBundleClassificationSource(db, sourceId, maxChars);
  return buildMessageClassificationSource(db, sourceId, maxChars);
}

async function buildMessageClassificationSource(
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

  for (const neighbor of await semanticNeighborsForMessages(db, [row.message_id], 3)) {
    addPart(chunks, parts, "semantic_neighbor", neighbor.id, neighbor.text);
  }

  const text = truncatePreservingWords(chunks.join("\n\n"), maxChars);
  return {
    sourceKind: "message",
    sourceId: row.message_id,
    messageId: row.message_id,
    text,
    contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    parts,
  };
}

async function buildBundleClassificationSource(
  db: Database,
  bundleId: string,
  maxChars: number,
): Promise<ClassificationSource | undefined> {
  const bundle = await db.execute<{ id: string; title: string | null; metadata: unknown }>(sql`
    select id, title, metadata
    from bundles
    where id = ${bundleId}
    limit 1
  `);
  if (!bundle.rows[0]) return undefined;

  const messages = await db.execute<SourceRow & { position: number; forward_context: string | null }>(sql`
    select
      m.id as message_id,
      m.telegram_date,
      m.message_type,
      m.current_text as message_text,
      bm.position,
      concat_ws(
        ', ',
        nullif(m.forward_origin_type, ''),
        nullif(m.forward_sender_name, ''),
        nullif(m.forward_sender_username, ''),
        nullif(m.forward_chat_title, '')
      ) as forward_context,
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
    from bundle_messages bm
    join messages m on m.id = bm.message_id
    where bm.bundle_id = ${bundleId}
    order by bm.position asc, m.telegram_date asc, m.telegram_message_id asc
  `);
  if (messages.rows.length === 0) return undefined;

  const chunks: string[] = [];
  const parts: ClassificationSource["parts"] = [];
  addPart(
    chunks,
    parts,
    "bundle_meta",
    bundleId,
    `bundle: ${bundle.rows[0].title ?? "untitled"}\nmetadata: ${JSON.stringify(bundle.rows[0].metadata)}`,
  );

  for (const row of messages.rows) {
    const normalized = textFromContent(row.normalized_text);
    addPart(
      chunks,
      parts,
      "bundle_message",
      row.message_id,
      [
        `message ${row.position + 1}`,
        `date: ${String(row.telegram_date)}`,
        `type: ${row.message_type}`,
        row.forward_context ? `forward: ${row.forward_context}` : undefined,
        normalized || row.message_text || undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    for (const attachment of attachmentContext(row.attachment_context)) {
      addPart(
        chunks,
        parts,
        "bundle_attachment",
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
  }

  for (const neighbor of await semanticNeighborsForMessages(
    db,
    messages.rows.map((row) => row.message_id),
    3,
  )) {
    addPart(chunks, parts, "semantic_neighbor", neighbor.id, neighbor.text);
  }

  const text = truncatePreservingWords(chunks.join("\n\n"), maxChars);
  return {
    sourceKind: "bundle",
    sourceId: bundleId,
    messageId: messages.rows[0]?.message_id ?? null,
    text,
    contentHash: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    parts,
  };
}

async function semanticNeighborsForMessages(db: Database, messageIds: string[], limit: number) {
  if (messageIds.length === 0) return [];
  const result = await db.execute<{ id: string; text: string }>(sql`
    with source_embeddings as (
      select embedding, provider, model, dimensions
      from embeddings
      where source_kind = 'message'
        and source_id in (${sql.join(
          messageIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      limit 5
    ),
    scored as (
      select
        e.source_id,
        max((
          select
            coalesce(sum(stored.value * query.value), 0)
            / nullif(
              sqrt(coalesce(sum(stored.value * stored.value), 0))
              * sqrt(coalesce(sum(query.value * query.value), 0)),
              0
            )
          from unnest(e.embedding) with ordinality as stored(value, ord)
          join unnest(se.embedding) with ordinality as query(value, ord)
            on query.ord = stored.ord
        ))::float as similarity
      from embeddings e
      join source_embeddings se
        on se.provider = e.provider
        and se.model = e.model
        and se.dimensions = e.dimensions
      where e.source_kind = 'message'
        and e.source_id not in (${sql.join(
          messageIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      group by e.source_id
    )
    select
      m.id,
      concat_ws(E'\n', 'related:', left(coalesce(m.current_text, ''), 500)) as text
    from scored
    join messages m on m.id = scored.source_id
    where scored.similarity is not null
      and coalesce(m.current_text, '') <> ''
    order by scored.similarity desc, m.telegram_date desc
    limit ${limit}
  `);
  return result.rows;
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
