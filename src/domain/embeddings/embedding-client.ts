import { z } from "zod";

const embedResponseSchema = z.object({
  model: z.string().optional(),
  embeddings: z.array(z.array(z.number())),
  total_duration: z.number().optional(),
  load_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
});

export interface EmbeddingClientOptions {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string;
  dimensions: number | undefined;
  timeoutMs: number;
}

export interface EmbedTextResult {
  embedding: number[];
  model: string;
  raw: unknown;
}

export class EmbeddingClient {
  constructor(private readonly options: EmbeddingClientOptions) {}

  async embedText(text: string): Promise<EmbedTextResult> {
    if (!this.options.baseUrl) {
      throw new Error("EMBEDDING_SERVICE_URL is not configured");
    }
    if (!text.trim()) {
      throw new Error("Cannot embed empty text");
    }

    const response = await fetch(new URL("/api/embed", this.options.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.options.model,
        input: text,
        truncate: true,
        ...(this.options.dimensions ? { dimensions: this.options.dimensions } : {}),
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Embedding service failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const raw: unknown = await response.json();
    const parsed = embedResponseSchema.parse(raw);
    const embedding = parsed.embeddings[0];
    if (!embedding || embedding.length === 0) {
      throw new Error("Embedding service returned no embedding");
    }
    return {
      embedding,
      model: parsed.model ?? this.options.model,
      raw,
    };
  }

  private headers() {
    return {
      "content-type": "application/json",
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
    };
  }
}
