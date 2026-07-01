import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Api } from "grammy";
import type { File } from "grammy/types";
import type { Database } from "../../db/client.js";
import { attachments, type Attachment } from "../../db/schema.js";
import type { LocalStorage } from "../../storage/local-storage.js";

export interface AttachmentDownloadSummary {
  attempted: number;
  downloaded: number;
  reused: number;
  skippedTooLarge: number;
  failed: number;
}

export class AttachmentService {
  constructor(
    private readonly db: Database,
    private readonly storage: LocalStorage,
    private readonly botApi: Api,
    private readonly botToken: string,
    private readonly maxBytes: number,
    private readonly maxAttempts: number,
  ) {}

  async downloadPendingForMessage(messageId: string): Promise<AttachmentDownloadSummary> {
    const pending = await this.db.query.attachments.findMany({
      where: eq(attachments.messageId, messageId),
    });

    return this.downloadAttachments(pending);
  }

  async retryFailedAttachments(limit = 20): Promise<AttachmentDownloadSummary> {
    const retryable = await this.db.query.attachments.findMany({
      where: and(
        inArray(attachments.downloadStatus, ["pending", "failed"]),
        sql`(${attachments.nextRetryAt} is null or ${attachments.nextRetryAt} <= now())`,
        sql`${attachments.downloadAttempts} < ${this.maxAttempts}`,
      ),
      orderBy: [asc(attachments.nextRetryAt), asc(attachments.createdAt)],
      limit,
    });

    return this.downloadAttachments(retryable);
  }

  private async downloadAttachments(
    attachmentRows: Attachment[],
  ): Promise<AttachmentDownloadSummary> {
    const summary: AttachmentDownloadSummary = {
      attempted: 0,
      downloaded: 0,
      reused: 0,
      skippedTooLarge: 0,
      failed: 0,
    };

    for (const attachment of attachmentRows) {
      if (attachment.downloadStatus === "downloaded") continue;
      if (attachment.sizeBytes !== null && attachment.sizeBytes > this.maxBytes) {
        await this.db
          .update(attachments)
          .set({
            downloadStatus: "skipped_too_large",
            error: "File exceeds MAX_ATTACHMENT_BYTES",
            lastDownloadAttemptAt: new Date(),
            nextRetryAt: null,
          })
          .where(eq(attachments.id, attachment.id));
        summary.skippedTooLarge += 1;
        continue;
      }

      const reused = await this.reuseDownloadedFile(attachment);
      if (reused) {
        summary.reused += 1;
        continue;
      }

      summary.attempted += 1;
      try {
        const file: File = await this.botApi.getFile(attachment.telegramFileId);
        if (!file.file_path) {
          throw new Error("Telegram getFile response did not include file_path");
        }
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
            downloadAttempts: attachment.downloadAttempts + 1,
            lastDownloadAttemptAt: new Date(),
            nextRetryAt: null,
            error: null,
          })
          .where(eq(attachments.id, attachment.id));
        summary.downloaded += 1;
      } catch (error) {
        const attempts = attachment.downloadAttempts + 1;
        await this.db
          .update(attachments)
          .set({
            downloadStatus: "failed",
            downloadAttempts: attempts,
            lastDownloadAttemptAt: new Date(),
            nextRetryAt:
              attempts >= this.maxAttempts ? null : this.nextRetryAt(attempts, new Date()),
            error: error instanceof Error ? error.message : String(error),
          })
          .where(eq(attachments.id, attachment.id));
        summary.failed += 1;
      }
    }

    return summary;
  }

  private async reuseDownloadedFile(attachment: Attachment) {
    const existing = await this.db.query.attachments.findFirst({
      where: and(
        eq(attachments.telegramFileUniqueId, attachment.telegramFileUniqueId),
        eq(attachments.downloadStatus, "downloaded"),
        ne(attachments.id, attachment.id),
        sql`${attachments.localPath} is not null`,
        sql`${attachments.sha256} is not null`,
      ),
    });
    if (!existing?.localPath || !existing.sha256) return false;

    await this.db
      .update(attachments)
      .set({
        localPath: existing.localPath,
        sha256: existing.sha256,
        sizeBytes: attachment.sizeBytes ?? existing.sizeBytes,
        downloadStatus: "downloaded",
        error: null,
        nextRetryAt: null,
      })
      .where(eq(attachments.id, attachment.id));
    return true;
  }

  private nextRetryAt(attempts: number, now: Date) {
    const delayMinutes = Math.min(24 * 60, 2 ** Math.max(0, attempts - 1));
    return new Date(now.getTime() + delayMinutes * 60_000);
  }
}
