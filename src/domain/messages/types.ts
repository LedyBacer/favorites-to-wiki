export type TelegramMessageType = "text" | "photo" | "document" | "voice" | "video" | "unknown";

export interface ForwardInfo {
  originType?: string | undefined;
  senderName?: string | undefined;
  senderUsername?: string | undefined;
  chatTitle?: string | undefined;
  date?: Date | undefined;
}

export interface AttachmentInput {
  telegramFileId: string;
  telegramFileUniqueId: string;
  originalFileName?: string | undefined;
  mimeType?: string | undefined;
  sizeBytes?: number | undefined;
}

export interface SaveMessageInput {
  telegramChatId: number;
  telegramMessageId: number;
  telegramUserId: number;
  telegramDate: Date;
  text?: string | undefined;
  messageType: TelegramMessageType;
  forward?: ForwardInfo | undefined;
  replyToTelegramMessageId?: number | undefined;
  telegramEditDate?: Date | undefined;
  metadata: Record<string, unknown>;
  attachments: AttachmentInput[];
}

export interface SaveMessageResult {
  messageId: string;
  created: boolean;
  versionCreated: boolean;
  attachmentCount: number;
}
