import { and, desc, eq, max, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { attachments, messages, messageVersions } from "../../db/schema.js";
import { hashMessageVersion } from "./hash.js";
import type { SaveMessageInput, SaveMessageResult } from "./types.js";

type MessageWriteDatabase = Pick<Database, "execute" | "query" | "insert" | "update" | "select">;

export class MessageService {
  constructor(private readonly db: Database) {}

  async saveTelegramMessage(input: SaveMessageInput): Promise<SaveMessageResult> {
    return this.db.transaction(async (tx) => this.saveTelegramMessageInTransaction(tx, input));
  }

  private async saveTelegramMessageInTransaction(
    db: MessageWriteDatabase,
    input: SaveMessageInput,
  ): Promise<SaveMessageResult> {
    const replyToMessageId = input.replyToTelegramMessageId
      ? await this.findInternalReplyMessageId(
          db,
          input.telegramChatId,
          input.replyToTelegramMessageId,
        )
      : undefined;

    const now = new Date();
    const contentHash = hashMessageVersion(input.text, input.metadata);
    let versionCreated = false;

    const insertedMessage = await db
      .insert(messages)
      .values({
        telegramChatId: input.telegramChatId,
        telegramMessageId: input.telegramMessageId,
        telegramUserId: input.telegramUserId,
        telegramDate: input.telegramDate,
        currentText: input.text,
        messageType: input.messageType,
        forwardOriginType: input.forward?.originType,
        forwardSenderName: input.forward?.senderName,
        forwardSenderUsername: input.forward?.senderUsername,
        forwardChatTitle: input.forward?.chatTitle,
        forwardDate: input.forward?.date,
        replyToTelegramMessageId: input.replyToTelegramMessageId,
        replyToMessageId,
        lastTelegramEditDate: input.telegramEditDate,
        metadata: input.metadata,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [messages.telegramChatId, messages.telegramMessageId],
      })
      .returning({ id: messages.id });

    const existing = insertedMessage[0]
      ? undefined
      : await db.query.messages.findFirst({
          where: and(
            eq(messages.telegramChatId, input.telegramChatId),
            eq(messages.telegramMessageId, input.telegramMessageId),
          ),
        });

    if (!insertedMessage[0] && !existing) {
      throw new Error("Failed to resolve message after Telegram identity conflict");
    }

    const messageId = insertedMessage[0]?.id ?? existing!.id;
    const created = Boolean(insertedMessage[0]);
    await this.lockMessageVersionWrites(db, messageId);

    if (!existing) {
      const insertedVersion = await db
        .insert(messageVersions)
        .values({
          messageId,
          version: 1,
          telegramEditDate: input.telegramEditDate,
          text: input.text,
          contentHash,
          metadata: input.metadata,
        })
        .onConflictDoNothing({
          target: [messageVersions.messageId, messageVersions.contentHash],
        })
        .returning({ id: messageVersions.id });
      versionCreated = insertedVersion.length > 0;
    } else {
      const duplicateVersion = await db.query.messageVersions.findFirst({
        where: and(
          eq(messageVersions.messageId, messageId),
          eq(messageVersions.contentHash, contentHash),
        ),
      });

      if (!duplicateVersion) {
        const versionRow = await db
          .select({ value: max(messageVersions.version) })
          .from(messageVersions)
          .where(eq(messageVersions.messageId, messageId));
        const nextVersion = (versionRow[0]?.value ?? 0) + 1;
        await db
          .update(messages)
          .set({
            currentText: input.text,
            messageType: input.messageType,
            replyToTelegramMessageId: input.replyToTelegramMessageId,
            replyToMessageId,
            lastTelegramEditDate: input.telegramEditDate ?? existing.lastTelegramEditDate,
            metadata: input.metadata,
            updatedAt: now,
          })
          .where(eq(messages.id, messageId));
        const insertedVersion = await db
          .insert(messageVersions)
          .values({
            messageId,
            version: nextVersion,
            telegramEditDate: input.telegramEditDate,
            text: input.text,
            contentHash,
            metadata: input.metadata,
          })
          .onConflictDoNothing({
            target: [messageVersions.messageId, messageVersions.contentHash],
          })
          .returning({ id: messageVersions.id });
        versionCreated = insertedVersion.length > 0;
      } else if (replyToMessageId && existing.replyToMessageId !== replyToMessageId) {
        await db
          .update(messages)
          .set({
            replyToTelegramMessageId: input.replyToTelegramMessageId,
            replyToMessageId,
            updatedAt: now,
          })
          .where(eq(messages.id, messageId));
      }
    }

    for (const attachment of input.attachments) {
      await db
        .insert(attachments)
        .values({
          messageId,
          telegramFileId: attachment.telegramFileId,
          telegramFileUniqueId: attachment.telegramFileUniqueId,
          originalFileName: attachment.originalFileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        })
        .onConflictDoNothing({ target: attachments.telegramFileUniqueId });
    }

    return {
      messageId,
      created,
      versionCreated,
      attachmentCount: input.attachments.length,
    };
  }

  private async findInternalReplyMessageId(
    db: MessageWriteDatabase,
    telegramChatId: number,
    replyToTelegramMessageId: number,
  ) {
    const repliedToMessage = await db.query.messages.findFirst({
      columns: { id: true },
      where: and(
        eq(messages.telegramChatId, telegramChatId),
        eq(messages.telegramMessageId, replyToTelegramMessageId),
      ),
    });
    return repliedToMessage?.id;
  }

  private async lockMessageVersionWrites(db: MessageWriteDatabase, messageId: string) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${messageId}))`);
  }

  async recent(limit: number) {
    return this.db.query.messages.findMany({
      orderBy: [desc(messages.telegramDate), desc(messages.createdAt)],
      limit,
      with: {
        attachments: true,
      },
    });
  }

  async stats() {
    const result = await this.db.execute<{
      messages_count: string;
      attachments_count: string;
      downloaded_count: string;
    }>(sql`
      select
        (select count(*) from messages) as messages_count,
        (select count(*) from attachments) as attachments_count,
        (select count(*) from attachments where download_status = 'downloaded') as downloaded_count
    `);
    return result.rows[0]!;
  }
}
