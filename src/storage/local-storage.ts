import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import fetch, { type Response } from "node-fetch";
import { buildAttachmentRelativePath } from "./path.js";

export interface StoredFile {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
}

export class LocalStorage {
  constructor(
    private readonly root: string,
    private readonly fetchFile: (url: string) => Promise<Response> = fetch,
  ) {}

  async ensureReady() {
    await mkdir(this.root, { recursive: true });
    await stat(this.root);
  }

  async download(input: {
    url: string;
    uniqueFileId: string;
    originalFileName?: string | undefined;
    mimeType?: string | undefined;
    maxBytes: number;
  }): Promise<StoredFile> {
    await this.ensureReady();
    const relativePath = buildAttachmentRelativePath(input);
    const finalPath = path.join(this.root, relativePath);
    const tempPath = `${finalPath}.part`;
    await mkdir(path.dirname(finalPath), { recursive: true });

    const response = await this.fetchFile(input.url);
    if (!response.ok || !response.body) {
      throw new Error(`Telegram file download failed with HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > input.maxBytes) {
      throw new Error(`File is too large: ${contentLength} bytes`);
    }

    const hash = createHash("sha256");
    let sizeBytes = 0;
    const writer = createWriteStream(tempPath, { flags: "wx" });

    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        sizeBytes += buffer.byteLength;
        if (sizeBytes > input.maxBytes) {
          throw new Error(`File is too large: ${sizeBytes} bytes`);
        }
        hash.update(buffer);
        if (!writer.write(buffer)) {
          await new Promise<void>((resolve) => writer.once("drain", resolve));
        }
      }
      await new Promise<void>((resolve, reject) => {
        writer.end((error: Error | null | undefined) => (error ? reject(error) : resolve()));
      });
      await rename(tempPath, finalPath);
    } catch (error) {
      writer.destroy();
      await rm(tempPath, { force: true });
      throw error;
    }

    return {
      relativePath,
      sha256: hash.digest("hex"),
      sizeBytes,
    };
  }

  async storeLocalFile(input: {
    sourcePath: string;
    uniqueFileId: string;
    originalFileName?: string | undefined;
    mimeType?: string | undefined;
    maxBytes: number;
  }): Promise<StoredFile> {
    await this.ensureReady();
    const relativePath = buildAttachmentRelativePath(input);
    const finalPath = path.join(this.root, relativePath);
    const tempPath = `${finalPath}.part`;
    await mkdir(path.dirname(finalPath), { recursive: true });

    const existing = await this.existingFile(finalPath, relativePath);
    if (existing) return existing;

    const sourceStat = await stat(input.sourcePath);
    if (sourceStat.size > input.maxBytes) {
      throw new Error(`File is too large: ${sourceStat.size} bytes`);
    }

    const hash = createHash("sha256");
    let sizeBytes = 0;
    const reader = createReadStream(input.sourcePath);
    const writer = createWriteStream(tempPath, { flags: "wx" });

    try {
      for await (const chunk of reader) {
        const buffer = Buffer.from(chunk);
        sizeBytes += buffer.byteLength;
        if (sizeBytes > input.maxBytes) {
          throw new Error(`File is too large: ${sizeBytes} bytes`);
        }
        hash.update(buffer);
        if (!writer.write(buffer)) {
          await new Promise<void>((resolve) => writer.once("drain", resolve));
        }
      }
      await new Promise<void>((resolve, reject) => {
        writer.end((error: Error | null | undefined) => (error ? reject(error) : resolve()));
      });
      await rename(tempPath, finalPath);
    } catch (error) {
      reader.destroy();
      writer.destroy();
      await rm(tempPath, { force: true });
      throw error;
    }

    return {
      relativePath,
      sha256: hash.digest("hex"),
      sizeBytes,
    };
  }

  async fileSha256(relativePath: string) {
    const hash = createHash("sha256");
    const stream = createReadStream(path.join(this.root, relativePath));
    for await (const chunk of stream) {
      hash.update(Buffer.from(chunk));
    }
    return hash.digest("hex");
  }

  private async existingFile(
    finalPath: string,
    relativePath: string,
  ): Promise<StoredFile | undefined> {
    try {
      const existingStat = await stat(finalPath);
      return {
        relativePath,
        sha256: await this.fileSha256(relativePath),
        sizeBytes: existingStat.size,
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }
}
