import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isSafeInteger(value)),
    ),
  STORAGE_ROOT: z.string().min(1).default("./data/storage"),
  MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  MAX_ATTACHMENT_DOWNLOAD_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  BOT_ACKNOWLEDGEMENTS: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  SEARCH_RESULT_LIMIT: z.coerce.number().int().min(1).max(20).default(5),
  OCR_SERVICE_URL: emptyStringToUndefined(z.string().url().optional()),
  OCR_SERVICE_API_KEY: emptyStringToUndefined(z.string().optional()),
  OCR_SERVICE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(30 * 60 * 1000)
    .default(300000),
  OCR_MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  ASR_SERVICE_URL: emptyStringToUndefined(z.string().url().optional()),
  ASR_SERVICE_API_KEY: emptyStringToUndefined(z.string().optional()),
  ASR_SERVICE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(2 * 60 * 60 * 1000)
    .default(1800000),
  ASR_MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(500 * 1024 * 1024),
  EMBEDDING_SERVICE_URL: emptyStringToUndefined(z.string().url().optional()),
  EMBEDDING_SERVICE_API_KEY: emptyStringToUndefined(z.string().optional()),
  EMBEDDING_MODEL: z.string().min(1).default("qwen3-embedding:0.6b"),
  EMBEDDING_DIMENSIONS: emptyStringToUndefined(z.coerce.number().int().positive().optional()),
  EMBEDDING_SERVICE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(30 * 60 * 1000)
    .default(300000),
  EMBEDDING_MAX_INPUT_CHARS: z.coerce.number().int().min(100).max(200000).default(12000),
  LLM_SERVICE_URL: emptyStringToUndefined(z.string().url().optional()),
  LLM_SERVICE_API_KEY: emptyStringToUndefined(z.string().optional()),
  LLM_MODEL: z.string().min(1).default("qwen3.5:4b"),
  LLM_VISION_MODEL: z.string().min(1).default("qwen3.5:4b"),
  LLM_SERVICE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60 * 60 * 1000)
    .default(600000),
  LLM_MAX_INPUT_CHARS: z.coerce.number().int().min(500).max(200000).default(20000),
  LLM_IMAGE_MAX_ATTACHMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  WORKER_IDLE_MS: z.coerce.number().int().min(1000).max(10 * 60 * 1000).default(15000),
  LOG_LEVEL: z.string().default("info"),
});

export type AppConfig = z.infer<typeof envSchema>;

function emptyStringToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  if (parsed.TELEGRAM_ALLOWED_USER_IDS.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one numeric Telegram user ID");
  }
  return parsed;
}
