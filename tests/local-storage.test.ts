import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Response } from "node-fetch";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorage } from "../src/storage/local-storage.js";
import { buildAttachmentRelativePath } from "../src/storage/path.js";

const storageRoot = path.join(process.cwd(), ".tmp-tests", "local-storage");

afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe("LocalStorage", () => {
  it("rejects files that exceed maxBytes before writing them", async () => {
    const storage = new LocalStorage(storageRoot, () =>
      Promise.resolve(new Response("too large", { headers: { "content-length": "100" } })),
    );

    await expect(
      storage.download({
        url: "https://telegram.example/file",
        uniqueFileId: "too-large",
        originalFileName: "too-large.txt",
        mimeType: "text/plain",
        maxBytes: 10,
      }),
    ).rejects.toThrow("File is too large");
  });

  it("removes partial files when streaming exceeds maxBytes", async () => {
    const storage = new LocalStorage(storageRoot, () =>
      Promise.resolve(new Response("12345678901234567890")),
    );
    const relativePath = buildAttachmentRelativePath({
      uniqueFileId: "partial-cleanup",
      originalFileName: "payload.txt",
      mimeType: "text/plain",
    });

    await expect(
      storage.download({
        url: "https://telegram.example/file",
        uniqueFileId: "partial-cleanup",
        originalFileName: "payload.txt",
        mimeType: "text/plain",
        maxBytes: 5,
      }),
    ).rejects.toThrow("File is too large");

    await expect(stat(path.join(storageRoot, relativePath))).rejects.toThrow();
    await expect(stat(path.join(storageRoot, `${relativePath}.part`))).rejects.toThrow();
  });

  it("uses .bin for files without known extension or MIME type", () => {
    const relativePath = buildAttachmentRelativePath({
      uniqueFileId: "unknown-extension",
      originalFileName: "payload",
      mimeType: "application/octet-stream",
    });

    expect(relativePath.endsWith(".bin")).toBe(true);
  });

  it("stores local files idempotently", async () => {
    const storage = new LocalStorage(storageRoot);
    const sourcePath = path.join(storageRoot, "source", "payload.txt");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "local export payload");

    const input = {
      sourcePath,
      uniqueFileId: "local-file",
      originalFileName: "payload.txt",
      mimeType: "text/plain",
      maxBytes: 1024,
    };
    const first = await storage.storeLocalFile(input);
    const second = await storage.storeLocalFile(input);

    expect(second).toEqual(first);
    await expect(stat(path.join(storageRoot, first.relativePath))).resolves.toBeTruthy();
  });
});
