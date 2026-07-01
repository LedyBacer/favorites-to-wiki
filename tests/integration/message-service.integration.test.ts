import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  attachments,
  derivedArtifacts,
  embeddings,
  messageVersions,
  processingJobs,
} from "../../src/db/schema.js";
import { MessageService } from "../../src/domain/messages/message-service.js";
import type { SaveMessageInput } from "../../src/domain/messages/types.js";
import { ProcessingJobService } from "../../src/domain/processing/processing-job-service.js";
import { PreprocessingService } from "../../src/domain/preprocessing/preprocessing-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("MessageService PostgreSQL integration", () => {
  let database: ReturnType<typeof createDatabase>;
  let db: Database;
  let service: MessageService;

  beforeAll(async () => {
    database = createDatabase(databaseUrl!);
    db = database.db;
    await runMigrations(db);
    service = new MessageService(db);
  });

  beforeEach(async () => {
    await db.execute(sql`
      truncate table
        derived_artifacts,
        embeddings,
        attachments,
        message_versions,
        bundle_messages,
        records,
        entities,
        relations,
        processing_jobs,
        bundles,
        messages
      restart identity cascade
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("applies migrations idempotently", async () => {
    await runMigrations(db);

    const result = await db.execute<{ table_name: string }>(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('messages', 'message_versions', 'attachments', 'processing_jobs', 'derived_artifacts', 'embeddings')
      order by table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "attachments",
      "derived_artifacts",
      "embeddings",
      "message_versions",
      "messages",
      "processing_jobs",
    ]);
  });

  it("handles concurrent duplicate first deliveries idempotently", async () => {
    const input = messageInput({ telegramMessageId: 1001, text: "same first delivery" });

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => service.saveTelegramMessage(input)),
    );

    const counts = await countMessagesAndVersions();
    expect(new Set(results.map((result) => result.messageId)).size).toBe(1);
    expect(results.filter((result) => result.created).length).toBe(1);
    expect(results.filter((result) => result.versionCreated).length).toBe(1);
    expect(counts.messages).toBe(1);
    expect(counts.versions).toBe(1);
  });

  it("does not create duplicate versions for concurrent identical edits", async () => {
    const original = messageInput({ telegramMessageId: 1002, text: "before edit" });
    await service.saveTelegramMessage(original);

    const edited = {
      ...original,
      text: "after edit",
      telegramEditDate: new Date("2026-07-01T01:00:00Z"),
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => service.saveTelegramMessage(edited)),
    );

    const counts = await countMessagesAndVersions();
    expect(results.filter((result) => result.versionCreated).length).toBe(1);
    expect(counts.messages).toBe(1);
    expect(counts.versions).toBe(2);
  });

  it("serializes concurrent different edits without version number conflicts", async () => {
    const original = messageInput({ telegramMessageId: 1003, text: "version 1" });
    await service.saveTelegramMessage(original);

    await Promise.all([
      service.saveTelegramMessage({
        ...original,
        text: "version 2",
        telegramEditDate: new Date("2026-07-01T01:01:00Z"),
      }),
      service.saveTelegramMessage({
        ...original,
        text: "version 3",
        telegramEditDate: new Date("2026-07-01T01:02:00Z"),
      }),
    ]);

    const versionRows = await db
      .select({ version: messageVersions.version })
      .from(messageVersions)
      .orderBy(messageVersions.version);
    expect(versionRows.map((row) => row.version)).toEqual([1, 2, 3]);
  });

  it("records duplicate Telegram files separately for different messages", async () => {
    await service.saveTelegramMessage(
      messageInput({
        telegramMessageId: 1004,
        text: "first file message",
        attachmentUniqueId: "same-telegram-file",
      }),
    );
    await service.saveTelegramMessage(
      messageInput({
        telegramMessageId: 1005,
        text: "second file message",
        attachmentUniqueId: "same-telegram-file",
      }),
    );

    const rows = await db.select({ id: attachments.id }).from(attachments);
    expect(rows).toHaveLength(2);
  });

  it("resolves reply links when the replied-to message already exists", async () => {
    const parent = await service.saveTelegramMessage(
      messageInput({ telegramMessageId: 1006, text: "parent" }),
    );

    await service.saveTelegramMessage({
      ...messageInput({ telegramMessageId: 1007, text: "reply" }),
      replyToTelegramMessageId: 1006,
    });

    const reply = await db.query.messages.findFirst({
      where: (table, { eq }) => eq(table.telegramMessageId, 1007),
    });
    expect(reply?.replyToMessageId).toBe(parent.messageId);
  });

  it("stores deterministic derived artifacts separately from source messages", async () => {
    const source = await service.saveTelegramMessage(
      messageInput({ telegramMessageId: 1008, text: "https://example.com #tag" }),
    );

    await db.insert(derivedArtifacts).values({
      sourceKind: "message",
      sourceId: source.messageId,
      artifactType: "extracted_metadata",
      artifactKey: "deterministic-v1",
      contentHash: "sha256:test",
      content: { urls: ["https://example.com"], hashtags: ["tag"] },
    });

    const rows = await db.select().from(derivedArtifacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceId).toBe(source.messageId);
    expect(rows[0]?.artifactType).toBe("extracted_metadata");
  });

  it("claims processing jobs atomically with worker ownership", async () => {
    const source = await service.saveTelegramMessage(
      messageInput({ telegramMessageId: 1009, text: "needs preprocessing" }),
    );
    await db.insert(processingJobs).values([
      {
        type: "extract_metadata",
        subjectKind: "message",
        subjectId: source.messageId,
        payload: { version: 1 },
      },
      {
        type: "normalize_text",
        subjectKind: "message",
        subjectId: source.messageId,
        payload: { version: 1 },
      },
    ]);

    const processingJobService = new ProcessingJobService(db);
    const firstClaim = await processingJobService.claimPendingJobs({
      workerId: "integration-worker-a",
      limit: 1,
    });
    const secondClaim = await processingJobService.claimPendingJobs({
      workerId: "integration-worker-b",
      limit: 10,
    });

    expect(firstClaim).toHaveLength(1);
    expect(secondClaim).toHaveLength(1);
    expect(firstClaim[0]?.lockedBy).toBe("integration-worker-a");
    expect(secondClaim[0]?.lockedBy).toBe("integration-worker-b");
    expect(firstClaim[0]?.id).not.toBe(secondClaim[0]?.id);

    await processingJobService.completeJob(firstClaim[0]!.id);
    const noImmediateReclaim = await processingJobService.claimPendingJobs({
      workerId: "integration-worker-c",
      limit: 10,
    });
    expect(noImmediateReclaim).toHaveLength(0);
  });

  it("runs deterministic preprocessing jobs idempotently", async () => {
    const source = await service.saveTelegramMessage(
      messageInput({
        telegramMessageId: 1010,
        text: "See https://example.com/docs #Phase2 on 2026-07-01",
        attachmentUniqueId: "phase2-file",
      }),
    );
    await db
      .update(attachments)
      .set({
        downloadStatus: "downloaded",
        localPath: "ph/phase2-file.pdf",
        sha256: "abc123",
        mimeType: "application/pdf",
        originalFileName: "phase2-file.pdf",
        sizeBytes: 42,
      })
      .where(eq(attachments.messageId, source.messageId));

    const preprocessing = new PreprocessingService(db);
    const first = await preprocessing.enqueueAndProcess("integration-preprocess", 20);
    const second = await preprocessing.enqueueAndProcess("integration-preprocess", 20);

    expect(first.jobsCreated).toBe(2);
    expect(first.jobsCompleted).toBe(2);
    expect(first.artifactsWritten).toBe(5);
    expect(second.jobsCreated).toBe(0);
    expect(second.jobsClaimed).toBe(0);

    const rows = await db.select().from(derivedArtifacts);
    expect(rows.map((row) => row.artifactType).sort()).toEqual([
      "extracted_metadata",
      "file_metadata",
      "file_preview",
      "link_preview",
      "normalized_text",
    ]);
    expect(rows.find((row) => row.artifactType === "extracted_metadata")?.content).toMatchObject({
      domains: ["example.com"],
      hashtags: ["phase2"],
      dates: [{ raw: "2026-07-01", normalized: "2026-07-01", kind: "iso" }],
    });
  });

  it("stores message embeddings separately from source messages", async () => {
    const source = await service.saveTelegramMessage(
      messageInput({ telegramMessageId: 1011, text: "semantic search source" }),
    );

    await db.insert(embeddings).values({
      sourceKind: "message",
      sourceId: source.messageId,
      provider: "ollama",
      model: "test-embedding",
      dimensions: 3,
      contentHash: "sha256:test",
      embedding: [0.1, 0.2, 0.3],
      metadata: { integrationTest: true },
    });
    await db.insert(derivedArtifacts).values({
      sourceKind: "message",
      sourceId: source.messageId,
      artifactType: "embedding_reference",
      artifactKey: "ollama:test-embedding",
      contentHash: "sha256:reference",
      content: {
        provider: "ollama",
        model: "test-embedding",
        dimensions: 3,
        contentHash: "sha256:test",
      },
    });

    const rows = await db.select().from(embeddings);
    const references = await db
      .select()
      .from(derivedArtifacts)
      .where(eq(derivedArtifacts.artifactType, "embedding_reference"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceId).toBe(source.messageId);
    expect(references).toHaveLength(1);
  });

  async function countMessagesAndVersions() {
    const result = await db.execute<{ messages_count: string; versions_count: string }>(sql`
      select
        (select count(*) from messages) as messages_count,
        (select count(*) from message_versions) as versions_count
    `);
    return {
      messages: Number(result.rows[0]!.messages_count),
      versions: Number(result.rows[0]!.versions_count),
    };
  }
});

function messageInput(input: {
  telegramMessageId: number;
  text: string;
  attachmentUniqueId?: string;
}): SaveMessageInput {
  return {
    telegramChatId: 9001,
    telegramMessageId: input.telegramMessageId,
    telegramUserId: 328430137,
    telegramDate: new Date("2026-07-01T00:00:00Z"),
    text: input.text,
    messageType: "text",
    metadata: { chatType: "private", integrationTest: true },
    attachments: input.attachmentUniqueId
      ? [
          {
            telegramFileId: `file-${input.attachmentUniqueId}`,
            telegramFileUniqueId: input.attachmentUniqueId,
            originalFileName: "same-file.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
          },
        ]
      : [],
  };
}
