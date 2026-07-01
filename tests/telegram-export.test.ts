import { describe, expect, it } from "vitest";
import {
  deriveTelegramDesktopExportIdentity,
  mapTelegramDesktopExportToSaveInputs,
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

  it("maps supported export messages into SaveMessageInput records", () => {
    const mapped = mapTelegramDesktopExportToSaveInputs(
      {
        name: "Saved Messages",
        type: "saved_messages",
        id: 42,
        messages: [
          {
            id: 10,
            type: "message",
            date_unixtime: 1782870000,
            edited_unixtime: 1782870300,
            text: "remember this",
            forwarded_from: "Alice",
          },
          {
            id: 11,
            type: "message",
            date_unixtime: 1782870600,
            file: "files/report.pdf",
            mime_type: "application/pdf",
            reply_to_message_id: 10,
          },
        ],
      },
      {
        telegramChatId: -9001,
        telegramUserId: 328430137,
        sourceFilePath: "/exports/result.json",
      },
    );

    expect(mapped).toHaveLength(2);
    expect(mapped[0]?.input).toMatchObject({
      telegramChatId: -9001,
      telegramMessageId: 10,
      telegramUserId: 328430137,
      text: "remember this",
      messageType: "text",
      forward: {
        originType: "telegram_desktop_export",
        senderName: "Alice",
      },
      metadata: {
        source: "telegram_desktop_export",
        sourceChatName: "Saved Messages",
        sourceChatType: "saved_messages",
        sourceChatId: 42,
        sourceFilePath: "/exports/result.json",
        sourceMessageId: 10,
      },
    });
    expect(mapped[0]?.input.telegramDate.toISOString()).toBe("2026-07-01T01:40:00.000Z");
    expect(mapped[0]?.input.telegramEditDate?.toISOString()).toBe("2026-07-01T01:45:00.000Z");

    expect(mapped[1]?.input.replyToTelegramMessageId).toBe(10);
    expect(mapped[1]?.attachmentSourcePath).toBe("files/report.pdf");
    expect(mapped[1]?.input.attachments).toEqual([
      {
        telegramFileId:
          "telegram-export:57808b97ca03ea300e03162cebf220297cb291cd3f68da3b7af785869ca188a6",
        telegramFileUniqueId:
          "telegram-export:57808b97ca03ea300e03162cebf220297cb291cd3f68da3b7af785869ca188a6",
        originalFileName: "report.pdf",
        mimeType: "application/pdf",
      },
    ]);
  });

  it("derives stable import identity from export chat metadata", () => {
    const exportData = {
      name: "Saved Messages",
      type: "saved_messages",
      id: 42,
      messages: [],
    };

    expect(deriveTelegramDesktopExportIdentity(exportData)).toEqual(
      deriveTelegramDesktopExportIdentity({
        ...exportData,
        messages: [{ id: 1, type: "message", text: "different payload" }],
      }),
    );
    expect(deriveTelegramDesktopExportIdentity(exportData).telegramChatId).toBeLessThan(0);
  });
});
