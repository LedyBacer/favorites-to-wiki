import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { relations as drizzleRelations, sql } from "drizzle-orm";

export const telegramMessageType = pgEnum("telegram_message_type", [
  "text",
  "photo",
  "document",
  "voice",
  "video",
  "unknown",
]);

export const recordType = pgEnum("record_type", [
  "note",
  "task",
  "task_list",
  "bookmark",
  "deal",
  "temporary_artifact",
  "file",
  "work_context",
  "knowledge",
  "idea",
  "event",
  "unknown",
]);

export const attachmentDownloadStatus = pgEnum("attachment_download_status", [
  "pending",
  "downloaded",
  "failed",
  "skipped_too_large",
]);

export const processingJobStatus = pgEnum("processing_job_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const derivedArtifactType = pgEnum("derived_artifact_type", [
  "normalized_text",
  "extracted_metadata",
  "file_metadata",
  "link_preview",
  "ocr_text",
  "transcript",
  "embedding_reference",
]);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
    telegramMessageId: integer("telegram_message_id").notNull(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    telegramDate: timestamp("telegram_date", { withTimezone: true }).notNull(),
    currentText: text("current_text"),
    messageType: telegramMessageType("message_type").notNull(),
    forwardOriginType: text("forward_origin_type"),
    forwardSenderName: text("forward_sender_name"),
    forwardSenderUsername: text("forward_sender_username"),
    forwardChatTitle: text("forward_chat_title"),
    forwardDate: timestamp("forward_date", { withTimezone: true }),
    replyToTelegramMessageId: integer("reply_to_telegram_message_id"),
    replyToMessageId: uuid("reply_to_message_id"),
    lastTelegramEditDate: timestamp("last_telegram_edit_date", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    telegramIdentity: unique("messages_telegram_identity_uq").on(
      table.telegramChatId,
      table.telegramMessageId,
    ),
    chatMessageIdx: index("messages_chat_message_idx").on(
      table.telegramChatId,
      table.telegramMessageId,
    ),
    searchIdx: index("messages_text_search_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.currentText}, ''))`,
    ),
  }),
);

export const messageVersions = pgTable(
  "message_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    telegramEditDate: timestamp("telegram_edit_date", { withTimezone: true }),
    text: text("text"),
    contentHash: text("content_hash").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageVersionUq: unique("message_versions_message_version_uq").on(
      table.messageId,
      table.version,
    ),
    messageHashUq: unique("message_versions_message_hash_uq").on(
      table.messageId,
      table.contentHash,
    ),
  }),
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    telegramFileId: text("telegram_file_id").notNull(),
    telegramFileUniqueId: text("telegram_file_unique_id").notNull(),
    originalFileName: text("original_file_name"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    localPath: text("local_path"),
    sha256: text("sha256"),
    downloadStatus: attachmentDownloadStatus("download_status").notNull().default("pending"),
    downloadAttempts: integer("download_attempts").notNull().default(0),
    lastDownloadAttemptAt: timestamp("last_download_attempt_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    messageFileUq: unique("attachments_message_file_uq").on(
      table.messageId,
      table.telegramFileUniqueId,
    ),
    uniqueFileIdx: index("attachments_unique_file_idx").on(table.telegramFileUniqueId),
    retryIdx: index("attachments_retry_idx").on(table.downloadStatus, table.nextRetryAt),
    filenameSearchIdx: index("attachments_filename_search_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.originalFileName}, ''))`,
    ),
  }),
);

export const bundles = pgTable("bundles", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bundleMessages = pgTable(
  "bundle_messages",
  {
    bundleId: uuid("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (table) => ({
    bundleMessageUq: unique("bundle_messages_bundle_message_uq").on(
      table.bundleId,
      table.messageId,
    ),
  }),
);

export const records = pgTable("records", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: recordType("type").notNull().default("unknown"),
  title: text("title"),
  body: text("body"),
  sourceMessageId: uuid("source_message_id").references(() => messages.id, {
    onDelete: "set null",
  }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const entities = pgTable("entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  name: text("name").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const graphRelations = pgTable("relations", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromKind: text("from_kind").notNull(),
  fromId: uuid("from_id").notNull(),
  toKind: text("to_kind").notNull(),
  toId: uuid("to_id").notNull(),
  type: text("type").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const processingJobs = pgTable("processing_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  subjectKind: text("subject_kind").notNull(),
  subjectId: uuid("subject_id").notNull(),
  status: processingJobStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  lockedBy: text("locked_by"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  lastError: text("last_error"),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const derivedArtifacts = pgTable(
  "derived_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKind: text("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    artifactType: derivedArtifactType("artifact_type").notNull(),
    artifactKey: text("artifact_key").notNull().default("default"),
    contentHash: text("content_hash").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceArtifactUq: unique("derived_artifacts_source_artifact_uq").on(
      table.sourceKind,
      table.sourceId,
      table.artifactType,
      table.artifactKey,
    ),
    sourceIdx: index("derived_artifacts_source_idx").on(table.sourceKind, table.sourceId),
    typeIdx: index("derived_artifacts_type_idx").on(table.artifactType),
  }),
);

export const messagesRelations = drizzleRelations(messages, ({ many, one }) => ({
  versions: many(messageVersions),
  attachments: many(attachments),
  replyToMessage: one(messages, {
    fields: [messages.replyToMessageId],
    references: [messages.id],
  }),
}));

export const messageVersionsRelations = drizzleRelations(messageVersions, ({ one }) => ({
  message: one(messages, {
    fields: [messageVersions.messageId],
    references: [messages.id],
  }),
}));

export const attachmentsRelations = drizzleRelations(attachments, ({ one }) => ({
  message: one(messages, {
    fields: [attachments.messageId],
    references: [messages.id],
  }),
}));

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type MessageVersion = typeof messageVersions.$inferSelect;
export type NewMessageVersion = typeof messageVersions.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type ProcessingJob = typeof processingJobs.$inferSelect;
export type NewProcessingJob = typeof processingJobs.$inferInsert;
export type DerivedArtifact = typeof derivedArtifacts.$inferSelect;
export type NewDerivedArtifact = typeof derivedArtifacts.$inferInsert;
