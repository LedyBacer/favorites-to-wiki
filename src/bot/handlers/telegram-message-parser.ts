import type { Message } from "grammy/types";
import type {
  AttachmentInput,
  ForwardInfo,
  SaveMessageInput,
  TelegramMessageType,
} from "../../domain/messages/types.js";

function unixDate(value: number | undefined) {
  return typeof value === "number" ? new Date(value * 1000) : undefined;
}

function extractForwardInfo(message: Message): ForwardInfo | undefined {
  const origin = message.forward_origin;
  if (!origin) return undefined;

  const common = {
    originType: origin.type,
    date: unixDate(origin.date),
  };

  if (origin.type === "user") {
    return {
      ...common,
      senderName: [origin.sender_user.first_name, origin.sender_user.last_name]
        .filter(Boolean)
        .join(" "),
      senderUsername: origin.sender_user.username,
    };
  }
  if (origin.type === "hidden_user") {
    return { ...common, senderName: origin.sender_user_name };
  }
  if (origin.type === "chat") {
    return {
      ...common,
      chatTitle: origin.sender_chat.title,
      senderUsername: origin.sender_chat.username,
    };
  }
  if (origin.type === "channel") {
    return {
      ...common,
      chatTitle: origin.chat.title,
      senderUsername: origin.chat.username,
    };
  }
  return common;
}

function pickLargestPhoto(message: Message): AttachmentInput[] {
  const photo = message.photo?.at(-1);
  if (!photo) return [];
  return [
    {
      telegramFileId: photo.file_id,
      telegramFileUniqueId: photo.file_unique_id,
      mimeType: "image/jpeg",
      sizeBytes: photo.file_size,
    },
  ];
}

function extractAttachments(message: Message): AttachmentInput[] {
  if ("document" in message && message.document) {
    return [
      {
        telegramFileId: message.document.file_id,
        telegramFileUniqueId: message.document.file_unique_id,
        originalFileName: message.document.file_name,
        mimeType: message.document.mime_type,
        sizeBytes: message.document.file_size,
      },
    ];
  }
  if ("voice" in message && message.voice) {
    return [
      {
        telegramFileId: message.voice.file_id,
        telegramFileUniqueId: message.voice.file_unique_id,
        mimeType: message.voice.mime_type,
        sizeBytes: message.voice.file_size,
      },
    ];
  }
  if ("video" in message && message.video) {
    return [
      {
        telegramFileId: message.video.file_id,
        telegramFileUniqueId: message.video.file_unique_id,
        originalFileName: message.video.file_name,
        mimeType: message.video.mime_type,
        sizeBytes: message.video.file_size,
      },
    ];
  }
  return pickLargestPhoto(message);
}

function detectMessageType(message: Message): TelegramMessageType {
  if ("document" in message && message.document) return "document";
  if ("voice" in message && message.voice) return "voice";
  if ("video" in message && message.video) return "video";
  if ("photo" in message && message.photo) return "photo";
  if ("text" in message && message.text) return "text";
  return "unknown";
}

export function parseTelegramMessage(message: Message): SaveMessageInput | undefined {
  const from = message.from;
  if (!from) return undefined;

  const text =
    "text" in message && message.text
      ? message.text
      : "caption" in message
        ? message.caption
        : undefined;
  const editDate = "edit_date" in message ? unixDate(message.edit_date) : undefined;

  return {
    telegramChatId: message.chat.id,
    telegramMessageId: message.message_id,
    telegramUserId: from.id,
    telegramDate: new Date(message.date * 1000),
    text,
    messageType: detectMessageType(message),
    forward: extractForwardInfo(message),
    replyToTelegramMessageId: message.reply_to_message?.message_id,
    telegramEditDate: editDate,
    attachments: extractAttachments(message),
    metadata: {
      chatType: message.chat.type,
      hasText: Boolean("text" in message && message.text),
      hasCaption: Boolean("caption" in message && message.caption),
      mediaGroupId: "media_group_id" in message ? message.media_group_id : undefined,
      entities: "entities" in message ? message.entities : undefined,
      captionEntities: "caption_entities" in message ? message.caption_entities : undefined,
    },
  };
}
