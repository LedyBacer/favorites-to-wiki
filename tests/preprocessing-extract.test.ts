import { describe, expect, it } from "vitest";
import {
  buildFileMetadata,
  buildFilePreview,
  buildLinkPreview,
  extractMessageMetadata,
  normalizeText,
} from "../src/domain/preprocessing/extract.js";
import type { Attachment } from "../src/db/schema.js";

describe("deterministic preprocessing extraction", () => {
  it("normalizes text without changing source content", () => {
    expect(normalizeText("  hello\n\nworld\t#Tag  ")).toEqual({
      text: "hello world #Tag",
      length: 16,
      wordCount: 3,
      hasText: true,
    });
  });

  it("extracts urls, domains, hashtags, mentions, and dates", () => {
    const metadata = extractMessageMetadata(
      "Look at https://Example.com/path?q=1, ping @Nikita about #Project on 01.07.2026",
    );

    expect(metadata.urls).toEqual([
      {
        url: "https://example.com/path?q=1",
        domain: "example.com",
        scheme: "https",
        path: "/path",
      },
    ]);
    expect(metadata.domains).toEqual(["example.com"]);
    expect(metadata.hashtags).toEqual(["project"]);
    expect(metadata.mentions).toEqual(["nikita"]);
    expect(metadata.dates).toContainEqual({
      raw: "01.07.2026",
      normalized: "2026-07-01",
      kind: "numeric",
    });
  });

  it("builds safe link previews without network fetches", () => {
    const preview = buildLinkPreview(extractMessageMetadata("www.example.org/docs"));

    expect(preview.previews).toEqual([
      {
        url: "https://www.example.org/docs",
        domain: "www.example.org",
        displayHost: "www.example.org",
        path: "/docs",
        scheme: "https",
        fetched: false,
      },
    ]);
  });

  it("derives file metadata and previews from attachment rows", () => {
    const metadata = buildFileMetadata({
      originalFileName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      localPath: "aa/report.pdf",
      sha256: "abc",
      downloadStatus: "downloaded",
    } as Attachment);

    expect(metadata.category).toBe("pdf");
    expect(metadata.extension).toBe("pdf");
    expect(buildFilePreview(metadata)).toMatchObject({
      label: "report.pdf",
      category: "pdf",
      availableLocally: true,
      hashAvailable: true,
    });
  });
});
