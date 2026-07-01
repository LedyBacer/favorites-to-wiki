import { describe, expect, it } from "vitest";
import {
  parseLimitPrefix,
  searchSnippet,
  splitTelegramMessage,
} from "../src/bot/commands/format.js";

describe("bot command formatting", () => {
  it("parses optional numeric limit prefixes", () => {
    expect(parseLimitPrefix("15 postgres search", 5, 20)).toEqual({
      limit: 15,
      rest: "postgres search",
    });
    expect(parseLimitPrefix("postgres search", 5, 20)).toEqual({
      limit: 5,
      rest: "postgres search",
    });
  });

  it("clamps limit prefixes to the configured maximum", () => {
    expect(parseLimitPrefix("999 postgres", 5, 20)).toEqual({
      limit: 20,
      rest: "postgres",
    });
    expect(parseLimitPrefix("0 postgres", 5, 20)).toEqual({
      limit: 1,
      rest: "postgres",
    });
  });

  it("creates snippets around matched query terms", () => {
    const text = `${"intro ".repeat(30)}important telegram note ${"tail ".repeat(30)}`;

    expect(searchSnippet(text, "telegram", 80)).toContain("important telegram note");
    expect(searchSnippet(text, "telegram", 80).startsWith("... ")).toBe(true);
  });

  it("splits long Telegram responses on paragraph boundaries when possible", () => {
    const text = ["first paragraph", "second paragraph", "third paragraph"].join("\n\n");

    expect(splitTelegramMessage(text, 40)).toEqual([
      "first paragraph\n\nsecond paragraph",
      "third paragraph",
    ]);
  });
});
