import { describe, expect, it } from "vitest";
import {
  classificationOutputSchema,
  imageAnalysisOutputSchema,
} from "../src/domain/llm/schemas.js";

describe("LLM output schemas", () => {
  it("normalizes valid classification output with defaults", () => {
    const parsed = classificationOutputSchema.parse({
      summary: "Покупка монитора",
      records: [
        {
          type: "deal",
          title: "Скидка на монитор",
          body: null,
          confidence: 0.8,
          tags: ["hardware"],
        },
      ],
      entities: [{ type: "product", name: "monitor", confidence: 0.7 }],
      relations: [
        { fromRecordIndex: 0, toEntityName: "monitor", type: "mentions", confidence: 0.6 },
      ],
    });

    expect(parsed.records[0]?.type).toBe("deal");
    expect(parsed.entities[0]?.name).toBe("monitor");
    expect(parsed.intent).toBe("unknown");
    expect(parsed.confidence).toBe(0.5);
    expect(parsed.needsClarification).toBe(false);
    expect(parsed.clarificationQuestion).toBeNull();
    expect(parsed.retention).toBe("keep");
  });

  it("normalizes unsupported record types to unknown", () => {
    const parsed = classificationOutputSchema.parse({
      summary: "",
      records: [
        {
          type: "password",
          title: "Secret",
          body: null,
          confidence: 0.5,
          tags: [],
        },
      ],
      entities: [],
      relations: [],
    });

    expect(parsed.records[0]?.type).toBe("unknown");
  });

  it("validates image analysis output", () => {
    const parsed = imageAnalysisOutputSchema.parse({
      description: "Screenshot of a settings page",
      visibleText: "Settings",
      language: "en",
      objects: ["screenshot"],
      tags: ["settings"],
      safetyNotes: null,
      confidence: 0.75,
    });

    expect(parsed.description).toContain("Screenshot");
    expect(parsed.tags).toEqual(["settings"]);
  });
});
