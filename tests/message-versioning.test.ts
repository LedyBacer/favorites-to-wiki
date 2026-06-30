import { describe, expect, it } from "vitest";
import { hashMessageVersion } from "../src/domain/messages/hash.js";
import type { SaveMessageInput, SaveMessageResult } from "../src/domain/messages/types.js";

class InMemoryMessageArchive {
  private readonly messages = new Map<
    string,
    { id: string; currentText?: string | undefined; versions: string[] }
  >();

  save(input: SaveMessageInput): SaveMessageResult {
    const key = `${input.telegramChatId}:${input.telegramMessageId}`;
    const hash = hashMessageVersion(input.text, input.metadata);
    const existing = this.messages.get(key);

    if (!existing) {
      const id = crypto.randomUUID();
      this.messages.set(key, { id, currentText: input.text, versions: [hash] });
      return {
        messageId: id,
        created: true,
        versionCreated: true,
        attachmentCount: input.attachments.length,
      };
    }

    if (existing.versions.includes(hash)) {
      return {
        messageId: existing.id,
        created: false,
        versionCreated: false,
        attachmentCount: input.attachments.length,
      };
    }

    existing.currentText = input.text;
    existing.versions.push(hash);
    return {
      messageId: existing.id,
      created: false,
      versionCreated: true,
      attachmentCount: input.attachments.length,
    };
  }

  versionCount(chatId: number, messageId: number) {
    return this.messages.get(`${chatId}:${messageId}`)?.versions.length ?? 0;
  }
}

const baseInput: SaveMessageInput = {
  telegramChatId: 1,
  telegramMessageId: 10,
  telegramUserId: 42,
  telegramDate: new Date("2026-01-01T00:00:00Z"),
  text: "first",
  messageType: "text",
  metadata: { chatType: "private" },
  attachments: [],
};

describe("message versioning", () => {
  it("saves a first message idempotently", () => {
    const archive = new InMemoryMessageArchive();

    const first = archive.save(baseInput);
    const second = archive.save(baseInput);

    expect(first.created).toBe(true);
    expect(first.versionCreated).toBe(true);
    expect(second.created).toBe(false);
    expect(second.versionCreated).toBe(false);
    expect(second.messageId).toBe(first.messageId);
    expect(archive.versionCount(1, 10)).toBe(1);
  });

  it("creates a new version after edit", () => {
    const archive = new InMemoryMessageArchive();

    archive.save(baseInput);
    const edited = archive.save({
      ...baseInput,
      text: "edited",
      telegramEditDate: new Date("2026-01-01T00:01:00Z"),
    });

    expect(edited.created).toBe(false);
    expect(edited.versionCreated).toBe(true);
    expect(archive.versionCount(1, 10)).toBe(2);
  });

  it("does not duplicate identical edited versions", () => {
    const archive = new InMemoryMessageArchive();
    const edited = {
      ...baseInput,
      text: "edited",
      telegramEditDate: new Date("2026-01-01T00:01:00Z"),
    };

    archive.save(baseInput);
    archive.save(edited);
    const duplicate = archive.save(edited);

    expect(duplicate.versionCreated).toBe(false);
    expect(archive.versionCount(1, 10)).toBe(2);
  });
});
