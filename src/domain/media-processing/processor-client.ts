import { readFile } from "node:fs/promises";
import path from "node:path";

export interface MediaProcessorClientOptions {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs: number;
  storageRoot: string;
  maxBytes: number;
}

export interface OcrServiceResult {
  text: string;
  language?: string | undefined;
  model?: string | undefined;
  lines?: unknown[] | undefined;
  raw?: unknown;
}

export interface AsrServiceResult {
  text: string;
  language?: string | undefined;
  languageProbability?: number | undefined;
  durationSeconds?: number | undefined;
  model?: string | undefined;
  segments?: unknown[] | undefined;
  raw?: unknown;
}

export class MediaProcessorClient {
  constructor(private readonly options: MediaProcessorClientOptions) {}

  async ocr(localPath: string, attachment: { id: string; mimeType: string | null }) {
    return this.postFile<OcrServiceResult>("/ocr", localPath, attachment);
  }

  async transcribe(localPath: string, attachment: { id: string; mimeType: string | null }) {
    return this.postFile<AsrServiceResult>("/transcribe", localPath, attachment);
  }

  private async postFile<T>(
    endpoint: string,
    localPath: string,
    attachment: { id: string; mimeType: string | null },
  ): Promise<T> {
    if (!this.options.baseUrl) {
      throw new Error(`Media processor URL is not configured for ${endpoint}`);
    }

    const filePath = this.resolveStoragePath(localPath);
    const file = await readFile(filePath);
    if (file.byteLength > this.options.maxBytes) {
      throw new Error(
        `Attachment ${attachment.id} exceeds processor limit: ${file.byteLength} > ${this.options.maxBytes}`,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const form = new FormData();
      const filename = path.basename(localPath);
      form.set(
        "file",
        new Blob([file], { type: attachment.mimeType ?? "application/octet-stream" }),
        filename,
      );

      const response = await fetch(new URL(endpoint, ensureTrailingSlash(this.options.baseUrl)), {
        method: "POST",
        headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
        body: form,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Media processor ${endpoint} failed: ${response.status} ${body}`.trim());
      }

      const json = await response.json();
      if (!isObject(json) || typeof json.text !== "string") {
        throw new Error(`Media processor ${endpoint} returned invalid JSON`);
      }
      return json as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveStoragePath(localPath: string) {
    const root = path.resolve(this.options.storageRoot);
    const resolved = path.resolve(root, localPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Attachment path escapes storage root: ${localPath}`);
    }
    return resolved;
  }
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
