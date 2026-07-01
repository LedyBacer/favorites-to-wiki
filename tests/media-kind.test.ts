import { describe, expect, it } from "vitest";
import type { Attachment } from "../src/db/schema.js";
import { isAsrCandidate, isOcrCandidate } from "../src/domain/media-processing/media-kind.js";

describe("media processing candidate detection", () => {
  it("selects downloaded image attachments for OCR", () => {
    expect(
      isOcrCandidate(
        attachment({
          mimeType: "image/png",
          localPath: "ab/screenshot.png",
          downloadStatus: "downloaded",
        }),
      ),
    ).toBe(true);
  });

  it("does not select unavailable images for OCR", () => {
    expect(
      isOcrCandidate(
        attachment({
          mimeType: "image/jpeg",
          localPath: null,
          downloadStatus: "pending",
        }),
      ),
    ).toBe(false);
  });

  it("selects audio and video attachments for ASR", () => {
    expect(
      isAsrCandidate(
        attachment({
          mimeType: "audio/ogg",
          localPath: "ab/voice.ogg",
          downloadStatus: "downloaded",
        }),
      ),
    ).toBe(true);
    expect(
      isAsrCandidate(
        attachment({
          mimeType: "video/mp4",
          localPath: "ab/video.mp4",
          downloadStatus: "downloaded",
        }),
      ),
    ).toBe(true);
  });
});

function attachment(
  input: Pick<Attachment, "mimeType" | "localPath" | "downloadStatus">,
): Attachment {
  return {
    id: "attachment-id",
    messageId: "message-id",
    telegramFileId: "file-id",
    telegramFileUniqueId: "unique-id",
    originalFileName: null,
    mimeType: input.mimeType,
    sizeBytes: null,
    localPath: input.localPath,
    sha256: null,
    downloadStatus: input.downloadStatus,
    downloadAttempts: 0,
    lastDownloadAttemptAt: null,
    nextRetryAt: null,
    error: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
  };
}
