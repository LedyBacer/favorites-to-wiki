import { describe, expect, it } from "vitest";
import { isAllowedTelegramUser } from "../src/bot/middleware/allowlist.js";

describe("allowlist", () => {
  it("allows only configured Telegram users", () => {
    expect(isAllowedTelegramUser(42, [42, 100])).toBe(true);
    expect(isAllowedTelegramUser(7, [42, 100])).toBe(false);
    expect(isAllowedTelegramUser(undefined, [42, 100])).toBe(false);
  });
});
