import { describe, expect, it } from "vitest";
import {
  parseTelegramDesktopExportJson,
  summarizeTelegramDesktopExport,
} from "../src/import/telegram-export.js";

describe("Telegram Desktop export parser", () => {
  it("extracts text from string and entity arrays", () => {
    const messages = parseTelegramDesktopExportJson({
      messages: [
        {
          id: 1,
          type: "message",
          date_unixtime: "1782870000",
          text: "plain text",
        },
        {
          id: 2,
          type: "message",
          text: ["hello ", { type: "bold", text: "world" }],
        },
      ],
    });

    expect(messages.map((message) => message.text)).toEqual(["plain text", "hello world"]);
    expect(messages[0]?.date?.toISOString()).toBe("2026-07-01T01:40:00.000Z");
  });

  it("classifies attachments and reports unsupported service messages", () => {
    const summary = summarizeTelegramDesktopExport({
      name: "Saved Messages",
      messages: [
        { id: 1, type: "message", text: "note" },
        {
          id: 2,
          type: "message",
          file: "files/report.pdf",
          mime_type: "application/pdf",
          forwarded_from: "Alice",
          reply_to_message_id: 1,
        },
        {
          id: 3,
          type: "message",
          photo: "photos/photo_1.jpg",
          edited_unixtime: 1782870300,
        },
        { id: 4, type: "service", action: "pin_message" },
      ],
    });

    expect(summary).toEqual({
      chatName: "Saved Messages",
      totalMessages: 4,
      supportedMessages: 3,
      unsupportedMessages: 1,
      textMessages: 1,
      attachmentMessages: 2,
      editedMessages: 1,
      forwardedMessages: 1,
      replyMessages: 1,
      unsupportedTypes: ["service"],
    });
  });
});
