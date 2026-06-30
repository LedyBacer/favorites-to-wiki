import { eq } from "drizzle-orm";
import type { Api } from "grammy";
import type { File } from "grammy/types";
import type { Database } from "../../db/client.js";
import { attachments } from "../../db/schema.js";
import type { LocalStorage } from "../../storage/local-storage.js";

export class AttachmentService {
  constructor(
    private readonly db: Database,
    private readonly storage: LocalStorage,
    private readonly botApi: Api,
    private readonly botToken: string,
    private readonly maxBytes: number,
  ) {}

  async downloadPendingForMessage(messageId: string) {
    const pending = await this.db.query.attachments.findMany({
      where: eq(attachments.messageId, messageId),
    });

    for (const attachment of pending) {
      if (attachment.downloadStatus === "downloaded") continue;
      if (attachment.sizeBytes !== null && attachment.sizeBytes > this.maxBytes) {
        await this.db
          .update(attachments)
          .set({ downloadStatus: "skipped_too_large", error: "File exceeds MAX_ATTACHMENT_BYTES" })
          .where(eq(attachments.id, attachment.id));
        continue;
      }

      try {
        const file: File = await this.botApi.getFile(attachment.telegramFileId);
        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const stored = await this.storage.download({
          url,
          uniqueFileId: attachment.telegramFileUniqueId,
          originalFileName: attachment.originalFileName ?? undefined,
          mimeType: attachment.mimeType ?? undefined,
          maxBytes: this.maxBytes,
        });
        await this.db
          .update(attachments)
          .set({
            localPath: stored.relativePath,
            sha256: stored.sha256,
            sizeBytes: attachment.sizeBytes ?? stored.sizeBytes,
            downloadStatus: "downloaded",
            error: null,
          })
          .where(eq(attachments.id, attachment.id));
      } catch (error) {
        await this.db
          .update(attachments)
          .set({
            downloadStatus: "failed",
            error: error instanceof Error ? error.message : String(error),
          })
          .where(eq(attachments.id, attachment.id));
      }
    }
  }
}
