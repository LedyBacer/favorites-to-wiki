import { and, desc, eq, max, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { attachments, messages, messageVersions } from "../../db/schema.js";
import { hashMessageVersion } from "./hash.js";
import type { SaveMessageInput, SaveMessageResult } from "./types.js";

export class MessageService {
  constructor(private readonly db: Database) {}

  async saveTelegramMessage(input: SaveMessageInput): Promise<SaveMessageResult> {
    const existing = await this.db.query.messages.findFirst({
      where: and(
        eq(messages.telegramChatId, input.telegramChatId),
        eq(messages.telegramMessageId, input.telegramMessageId),
      ),
    });

    const now = new Date();
    const contentHash = hashMessageVersion(input.text, input.metadata);
    let messageId: string;
    let created = false;
    let versionCreated = false;

    if (!existing) {
      const inserted = await this.db
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
          lastTelegramEditDate: input.telegramEditDate,
          metadata: input.metadata,
          updatedAt: now,
        })
        .returning({ id: messages.id });
      messageId = inserted[0]!.id;
      created = true;
      versionCreated = true;
      await this.db.insert(messageVersions).values({
        messageId,
        version: 1,
        telegramEditDate: input.telegramEditDate,
        text: input.text,
        contentHash,
        metadata: input.metadata,
      });
    } else {
      messageId = existing.id;
      const duplicateVersion = await this.db.query.messageVersions.findFirst({
        where: and(
          eq(messageVersions.messageId, messageId),
          eq(messageVersions.contentHash, contentHash),
        ),
      });

      if (!duplicateVersion) {
        const versionRow = await this.db
          .select({ value: max(messageVersions.version) })
          .from(messageVersions)
          .where(eq(messageVersions.messageId, messageId));
        const nextVersion = (versionRow[0]?.value ?? 0) + 1;
        await this.db
          .update(messages)
          .set({
            currentText: input.text,
            messageType: input.messageType,
            lastTelegramEditDate: input.telegramEditDate ?? existing.lastTelegramEditDate,
            metadata: input.metadata,
            updatedAt: now,
          })
          .where(eq(messages.id, messageId));
        await this.db.insert(messageVersions).values({
          messageId,
          version: nextVersion,
          telegramEditDate: input.telegramEditDate,
          text: input.text,
          contentHash,
          metadata: input.metadata,
        });
        versionCreated = true;
      }
    }

    for (const attachment of input.attachments) {
      await this.db
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
