import { describe, expect, it } from "vitest";
import { buildAttachmentRelativePath, sanitizeFileName } from "../src/storage/path.js";

describe("attachment paths", () => {
  it("sanitizes unsafe file names", () => {
    expect(sanitizeFileName("../../secret token.pdf", "fallback.bin")).toBe("secret_token.pdf");
  });

  it("builds a relative path with a safe extension fallback", () => {
    const result = buildAttachmentRelativePath({
      uniqueFileId: "abc/../unsafe",
      originalFileName: undefined,
      mimeType: "application/octet-stream",
    });

    expect(result).toBe("un/unsafe-unsafe.bin");
    expect(result.includes("..")).toBe(false);
    expect(result.startsWith("/")).toBe(false);
  });
});
