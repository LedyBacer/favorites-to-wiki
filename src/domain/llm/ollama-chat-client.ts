import { z } from "zod";

const chatResponseSchema = z.object({
  model: z.string().optional(),
  message: z.object({
    role: z.string().optional(),
    content: z.string(),
  }),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  total_duration: z.number().optional(),
  load_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

export interface OllamaChatClientOptions {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  timeoutMs: number;
}

export interface ChatJsonOptions<TSchema extends z.ZodTypeAny> {
  model: string;
  messages: Array<{
    role: "system" | "user";
    content: string;
    images?: string[];
  }>;
  schema: Record<string, unknown>;
  responseSchema: TSchema;
}

export interface ChatJsonResult<TSchema extends z.ZodTypeAny> {
  value: z.output<TSchema>;
  model: string;
  raw: unknown;
}

export class OllamaChatClient {
  constructor(private readonly options: OllamaChatClientOptions) {}

  async chatJson<TSchema extends z.ZodTypeAny>(
    options: ChatJsonOptions<TSchema>,
  ): Promise<ChatJsonResult<TSchema>> {
    if (!this.options.baseUrl) {
      throw new Error("LLM_SERVICE_URL is not configured");
    }

    const response = await fetch(new URL("/api/chat", this.options.baseUrl), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: false,
        format: options.schema,
        think: false,
        options: {
          temperature: 0,
          num_predict: 2048,
        },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM service failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const raw: unknown = await response.json();
    const parsed = chatResponseSchema.parse(raw);
    const json = parseJsonObject(parsed.message.content);
    return {
      value: options.responseSchema.parse(json) as z.output<TSchema>,
      model: parsed.model ?? options.model,
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

function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const json = firstBalancedJsonObject(content);
    if (!json) throw new Error("LLM response did not contain JSON");
    return JSON.parse(json);
  }
}

function firstBalancedJsonObject(content: string) {
  const start = content.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }

  return undefined;
}
