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
  });

  it("rejects unsupported record types", () => {
    expect(() =>
      classificationOutputSchema.parse({
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
      }),
    ).toThrow();
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
