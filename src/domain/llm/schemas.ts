import { z } from "zod";

export const classificationRecordTypes = [
  "note",
  "task",
  "task_list",
  "bookmark",
  "deal",
  "temporary_artifact",
  "file",
  "work_context",
  "knowledge",
  "idea",
  "event",
  "unknown",
] as const;

export const classificationOutputSchema = z.object({
  summary: z.string().max(1000).default(""),
  records: z
    .array(
      z.object({
        type: z.enum(classificationRecordTypes),
        title: z.string().min(1).max(240).catch("Без названия"),
        body: z.string().max(4000).nullable().catch(null),
        confidence: z.number().min(0).max(1).catch(0.5),
        tags: z.array(z.string().min(1).max(64)).max(12).catch([]),
      }),
    )
    .max(3)
    .default([]),
  entities: z
    .array(
      z.object({
        type: z.string().min(1).max(80).catch("unknown"),
        name: z.string().min(1).max(240),
        confidence: z.number().min(0).max(1).catch(0.5),
      }),
    )
    .max(8)
    .default([]),
  relations: z
    .array(
      z.object({
        fromRecordIndex: z.number().int().min(0).max(2),
        toEntityName: z.string().min(1).max(240),
        type: z.string().min(1).max(80).catch("mentions"),
        confidence: z.number().min(0).max(1).catch(0.5),
      }),
    )
    .max(16)
    .default([]),
});

export type ClassificationOutput = z.output<typeof classificationOutputSchema>;

export const classificationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    records: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: classificationRecordTypes },
          title: { type: "string" },
          body: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["type", "title", "body", "confidence", "tags"],
      },
    },
    entities: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["type", "name", "confidence"],
      },
    },
    relations: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fromRecordIndex: { type: "integer", minimum: 0, maximum: 2 },
          toEntityName: { type: "string" },
          type: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["fromRecordIndex", "toEntityName", "type", "confidence"],
      },
    },
  },
  required: ["summary", "records", "entities", "relations"],
};

export const imageAnalysisOutputSchema = z.object({
  description: textField(3000).catch("Описание изображения недоступно"),
  visibleText: nullableTextField(4000).catch(null),
  language: nullableTextField(40).catch(null),
  objects: stringList(80, 30).catch([]),
  tags: stringList(64, 30).catch([]),
  safetyNotes: nullableTextField(1000).catch(null),
  confidence: z.number().min(0).max(1).catch(0.5),
});

export type ImageAnalysisOutput = z.output<typeof imageAnalysisOutputSchema>;

export const imageAnalysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    description: { type: "string" },
    visibleText: { type: ["string", "null"] },
    language: { type: ["string", "null"] },
    objects: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    safetyNotes: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "description",
    "visibleText",
    "language",
    "objects",
    "tags",
    "safetyNotes",
    "confidence",
  ],
};

function textField(maxLength: number) {
  return z.preprocess((value) => valueToText(value), z.string().min(1).max(maxLength));
}

function nullableTextField(maxLength: number) {
  return z.preprocess(
    (value) => (value === null || value === undefined ? null : valueToText(value)),
    z.string().max(maxLength).nullable(),
  );
}

function stringList(maxItemLength: number, maxItems: number) {
  return z.preprocess((value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => valueToText(item))
      .filter((item): item is string => Boolean(item?.trim()))
      .slice(0, maxItems);
  }, z.array(z.string().min(1).max(maxItemLength)).max(maxItems));
}

function valueToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(valueToText).filter(Boolean).join("; ");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([key, item]) => {
        const text = valueToText(item);
        return text ? `${key}: ${text}` : undefined;
      })
      .filter(Boolean)
      .join("; ");
  }
  return undefined;
}
