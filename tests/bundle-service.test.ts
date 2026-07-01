import { describe, expect, it } from "vitest";
import {
  buildAutoBundleGroups,
  type BundleCandidateRow,
} from "../src/domain/bundles/bundle-service.js";

describe("auto bundle grouping", () => {
  it("groups Telegram media groups", () => {
    const groups = buildAutoBundleGroups([
      row("a", 1, { mediaGroupId: "album-1" }),
      row("b", 2, { mediaGroupId: "album-1" }),
      row("c", 3, { mediaGroupId: "album-2" }),
    ]);

    expect(groups).toMatchObject([
      { rule: "media_group", messageIds: ["a", "b"] },
    ]);
  });

  it("groups reply-linked messages", () => {
    const groups = buildAutoBundleGroups([
      row("parent", 1),
      row("reply", 2, {}, { replyToMessageId: "parent" }),
    ]);

    expect(groups).toMatchObject([
      { rule: "reply_thread", messageIds: ["parent", "reply"] },
    ]);
  });

  it("groups sequential forwards from the same source", () => {
    const groups = buildAutoBundleGroups([
      row("a", 1, {}, { forwardSenderUsername: "source" }),
      row("b", 2, {}, { forwardSenderUsername: "source" }),
      row("c", 3, {}, { forwardSenderUsername: "other" }),
    ]);

    expect(groups).toMatchObject([
      { rule: "sequential_forward", messageIds: ["a", "b"] },
    ]);
  });

  it("groups text followed immediately by an attachment", () => {
    const groups = buildAutoBundleGroups([
      row("text", 1, {}, { text: "caption" }),
      row("file", 2, {}, { attachmentCount: "1", text: null }),
    ]);

    expect(groups).toMatchObject([
      { rule: "text_then_attachment", messageIds: ["text", "file"] },
    ]);
  });

  it("does not group unrelated owner messages only by time proximity", () => {
    const groups = buildAutoBundleGroups([
      row("a", 1),
      row("b", 2),
      row("far", 20),
      row("far2", 30),
    ]);

    expect(groups).toEqual([]);
  });

  it("keeps a stable media group key when a message is appended", () => {
    const first = buildAutoBundleGroups([
      row("a", 1, { mediaGroupId: "album-1" }),
      row("b", 2, { mediaGroupId: "album-1" }),
    ]);
    const appended = buildAutoBundleGroups([
      row("a", 1, { mediaGroupId: "album-1" }),
      row("b", 2, { mediaGroupId: "album-1" }),
      row("c", 3, { mediaGroupId: "album-1" }),
    ]);

    expect(first[0]?.key).toBe(appended[0]?.key);
    expect(appended[0]?.messageIds).toEqual(["a", "b", "c"]);
  });
});

function row(
  id: string,
  minute: number,
  metadata: Record<string, unknown> = {},
  overrides: Partial<BundleCandidateRow> & {
    attachmentCount?: string;
    forwardSenderUsername?: string;
    replyToMessageId?: string;
    text?: string | null;
  } = {},
): BundleCandidateRow {
  return {
    id,
    telegram_chat_id: 1,
    telegram_message_id: minute,
    telegram_user_id: 10,
    telegram_date: new Date(Date.UTC(2026, 0, 1, 0, minute, 0)),
    current_text: overrides.text ?? "message",
    message_type: "text",
    forward_origin_type: overrides.forwardSenderUsername ? "user" : null,
    forward_sender_name: null,
    forward_sender_username: overrides.forwardSenderUsername ?? null,
    forward_chat_title: null,
    reply_to_message_id: overrides.replyToMessageId ?? null,
    metadata,
    attachment_count: overrides.attachmentCount ?? "0",
    ...overrides,
  };
}
