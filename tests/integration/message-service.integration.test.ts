import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { messageVersions } from "../../src/db/schema.js";
import { MessageService } from "../../src/domain/messages/message-service.js";
import type { SaveMessageInput } from "../../src/domain/messages/types.js";

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
        and table_name in ('messages', 'message_versions', 'attachments', 'processing_jobs')
      order by table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "attachments",
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

function messageInput(input: { telegramMessageId: number; text: string }): SaveMessageInput {
  return {
    telegramChatId: 9001,
    telegramMessageId: input.telegramMessageId,
    telegramUserId: 328430137,
    telegramDate: new Date("2026-07-01T00:00:00Z"),
    text: input.text,
    messageType: "text",
    metadata: { chatType: "private", integrationTest: true },
    attachments: [],
  };
}
