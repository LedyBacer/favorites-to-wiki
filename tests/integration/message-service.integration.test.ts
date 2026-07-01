import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  attachments,
  bundleMessages,
  bundles,
  derivedArtifacts,
  embeddings,
  messageVersions,
  processingJobs,
  records,
} from "../../src/db/schema.js";
import { buildClassificationSource } from "../../src/domain/llm/classification-source.js";
import { LlmClassificationService } from "../../src/domain/llm/llm-classification-service.js";
import { MessageService } from "../../src/domain/messages/message-service.js";
import type { SaveMessageInput } from "../../src/domain/messages/types.js";
import { ProcessingJobService } from "../../src/domain/processing/processing-job-service.js";
import { PreprocessingService } from "../../src/domain/preprocessing/preprocessing-service.js";
import { ReviewService } from "../../src/domain/review/review-service.js";

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

  it("enqueues later stale bundles when the first bundle is already current", async () => {
    const classification = classificationService(db);
    const bundleIds: string[] = [];

    for (const index of [0, 1, 2]) {
      const first = await service.saveTelegramMessage(
        messageInput({
          telegramMessageId: 1100 + index * 10,
          text: `bundle ${index} first`,
        }),
      );
      const second = await service.saveTelegramMessage(
        messageInput({
          telegramMessageId: 1101 + index * 10,
          text: `bundle ${index} second`,
        }),
      );
      const inserted = await db
        .insert(bundles)
        .values({
          title: `Bundle ${index}`,
          status: "closed",
          metadata: {
            createdBy: "auto_bundle_service",
            groupKey: `integration-${index}`,
          },
        })
        .returning({ id: bundles.id });
      const bundleId = inserted[0]!.id;
      bundleIds.push(bundleId);
      await db.insert(bundleMessages).values([
        { bundleId, messageId: first.messageId, position: 0 },
        { bundleId, messageId: second.messageId, position: 1 },
      ]);
    }

    const currentSource = await buildClassificationSource(db, bundleIds[0]!, 20_000, "bundle");
    await db.insert(derivedArtifacts).values({
      sourceKind: "bundle",
      sourceId: bundleIds[0]!,
      artifactType: "llm_classification",
      artifactKey: "ollama:test-llm",
      contentHash: "sha256:classification",
      content: { sourceContentHash: currentSource!.contentHash },
    });
    await db.insert(processingJobs).values({
      type: "llm_classification",
      subjectKind: "bundle",
      subjectId: bundleIds[0]!,
      status: "completed",
      inputHash: currentSource!.contentHash,
      generationKey: "phase7:ollama:test-llm:classification:v3",
      payload: { integrationTest: true },
      completedAt: new Date(),
    });

    const created = await classification.enqueueMissing(2);
    const queued = await db
      .select()
      .from(processingJobs)
      .where(sql`type = 'llm_classification' and subject_kind = 'bundle' and status = 'pending'`);

    expect(created).toBe(2);
    expect(queued.map((job) => job.subjectId).sort()).toEqual(bundleIds.slice(1).sort());
  });

  it("reconciles changed proposed record titles without leaving two active proposals", async () => {
    const classification = classificationService(db);
    const source = await service.saveTelegramMessage(
      messageInput({ telegramMessageId: 1200, text: "record title changes" }),
    );
    const classificationSource = proposalSource(source.messageId);

    await persistProposal(classification, classificationSource, ["Old title"]);
    await persistProposal(classification, classificationSource, ["New title"]);

    const active = await db
      .select()
      .from(records)
      .where(sql`status = 'proposed' and metadata->>'sourceId' = ${source.messageId}`);
    expect(active).toHaveLength(1);
    expect(active[0]?.title).toBe("New title");
  });

  it("supersedes removed proposed records on reclassification", async () => {
    const classification = classificationService(db);
    const source = await service.saveTelegramMessage(
      messageInput({ telegramMessageId: 1201, text: "record count shrinks" }),
    );
    const classificationSource = proposalSource(source.messageId);

    await persistProposal(classification, classificationSource, ["One", "Two", "Three"]);
    await persistProposal(classification, classificationSource, ["One"]);

    const rows = await db
      .select({ status: records.status })
      .from(records)
      .where(sql`metadata->>'sourceId' = ${source.messageId}`);
    expect(rows.filter((row) => row.status === "proposed")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "superseded")).toHaveLength(2);
  });

  it("does not overwrite accepted records during proposal reconciliation", async () => {
    const classification = classificationService(db);
    const source = await service.saveTelegramMessage(
      messageInput({ telegramMessageId: 1202, text: "accepted record stays" }),
    );
    const classificationSource = proposalSource(source.messageId);

    await persistProposal(classification, classificationSource, ["Accepted title"]);
    await db
      .update(records)
      .set({ status: "accepted", title: "Manual accepted title" })
      .where(sql`metadata->>'sourceId' = ${source.messageId}`);
    await persistProposal(classification, classificationSource, ["Different model title"]);

    const rows = await db
      .select({ status: records.status, title: records.title })
      .from(records)
      .where(sql`metadata->>'sourceId' = ${source.messageId}`);
    expect(rows).toContainEqual({ status: "accepted", title: "Manual accepted title" });
  });

  it("stores clarification answers separately and reopens classification", async () => {
    const source = await service.saveTelegramMessage(
      messageInput({ telegramMessageId: 1203, text: "needs a clarification" }),
    );
    const inserted = await db.execute<{ id: string }>(sql`
      insert into clarification_requests (
        source_kind,
        source_id,
        provider,
        model,
        generation_key,
        question,
        question_hash,
        status
      )
      values (
        'message',
        ${source.messageId},
        'ollama',
        'test-llm',
        'phase7:ollama:test-llm:classification:v3',
        'What is the project?',
        'question-hash',
        'pending'
      )
      returning id
    `);

    const review = new ReviewService(db, { llmMaxInputChars: 20_000 });
    const changed = await review.answerClarification(
      inserted.rows[0]!.id,
      "This belongs to Project X.",
      328430137,
      777,
    );

    const request = await db.execute<{ status: string; answer: string | null }>(sql`
      select status, answer
      from clarification_requests
      where id = ${inserted.rows[0]!.id}
    `);
    const job = await db.execute<{ status: string; input_hash: string | null }>(sql`
      select status, input_hash
      from processing_jobs
      where type = 'llm_classification'
        and subject_kind = 'message'
        and subject_id = ${source.messageId}
    `);
    const classificationSource = await buildClassificationSource(db, source.messageId, 20_000);

    expect(changed).toBe(true);
    expect(request.rows[0]).toMatchObject({
      status: "answered",
      answer: "This belongs to Project X.",
    });
    expect(job.rows[0]?.status).toBe("pending");
    expect(job.rows[0]?.input_hash).toBe(classificationSource?.contentHash);
    expect(classificationSource?.text).toContain("clarification answer: This belongs to Project X.");
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

function classificationService(db: Database) {
  return new LlmClassificationService(db, {
    LLM_SERVICE_URL: undefined,
    LLM_SERVICE_API_KEY: undefined,
    LLM_MODEL: "test-llm",
    LLM_SERVICE_TIMEOUT_MS: 1000,
    LLM_MAX_INPUT_CHARS: 20_000,
  });
}

function proposalSource(messageId: string) {
  return {
    sourceKind: "message" as const,
    sourceId: messageId,
    messageId,
    text: "classification source",
    contentHash: "sha256:classification-source",
    parts: [{ kind: "message_text", sourceId: messageId, length: 21 }],
  };
}

async function persistProposal(
  service: LlmClassificationService,
  source: ReturnType<typeof proposalSource>,
  titles: string[],
) {
  await (
    service as unknown as {
      persistProposal: (
        source: ReturnType<typeof proposalSource>,
        output: {
          summary: string;
          intent: string;
          confidence: number;
          needsClarification: boolean;
          clarificationQuestion: string | null;
          retention: "keep";
          records: Array<{
            type: "note";
            title: string;
            body: string | null;
            confidence: number;
            tags: string[];
          }>;
          entities: [];
          relations: [];
        },
      ) => Promise<unknown>;
    }
  ).persistProposal(source, {
    summary: "summary",
    intent: "capture",
    confidence: 0.8,
    needsClarification: false,
    clarificationQuestion: null,
    retention: "keep",
    records: titles.map((title) => ({
      type: "note",
      title,
      body: null,
      confidence: 0.8,
      tags: [],
    })),
    entities: [],
    relations: [],
  });
}

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
