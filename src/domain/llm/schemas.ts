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
        title: z.string().min(1).max(240),
        body: z.string().max(4000).nullable().default(null),
        confidence: z.number().min(0).max(1).default(0.5),
        tags: z.array(z.string().min(1).max(64)).max(12).default([]),
      }),
    )
    .max(3)
    .default([]),
  entities: z
    .array(
      z.object({
        type: z.string().min(1).max(80),
        name: z.string().min(1).max(240),
        confidence: z.number().min(0).max(1).default(0.5),
      }),
    )
    .max(8)
    .default([]),
  relations: z
    .array(
      z.object({
        fromRecordIndex: z.number().int().min(0).max(2),
        toEntityName: z.string().min(1).max(240),
        type: z.string().min(1).max(80),
        confidence: z.number().min(0).max(1).default(0.5),
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
  description: z.string().min(1).max(3000),
  visibleText: z.string().max(4000).nullable().default(null),
  language: z.string().max(40).nullable().default(null),
  objects: z.array(z.string().min(1).max(80)).max(30).default([]),
  tags: z.array(z.string().min(1).max(64)).max(30).default([]),
  safetyNotes: z.string().max(1000).nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
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
