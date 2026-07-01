# Architecture

## Goal

The first milestone is a reliable Telegram-first personal inbox. The system stores original Telegram messages and files with enough metadata to support later AI processing, but it does not classify, summarize, OCR, transcribe, or call external AI providers yet.

## Stack Decisions

- Node.js 22 and strict TypeScript for a small, self-hosted service with predictable runtime behavior.
- grammY for Telegram Bot API integration because it has first-class TypeScript support and a small long-polling setup.
- PostgreSQL as the canonical store for messages, versions, attachments, future records, entities, relations, and processing jobs.
- Drizzle ORM instead of Prisma because this project benefits from explicit SQL-friendly schema control, PostgreSQL full-text indexes, lightweight migrations, and no generated client lifecycle.
- Local filesystem storage behind a Docker volume for Telegram files. The database stores relative paths, SHA-256 hashes, Telegram file IDs, and download status.
- Zod validates environment configuration at startup.
- Vitest covers critical deterministic logic.

## Data Boundaries

Original Telegram content is stored in `messages`, `message_versions`, and `attachments`. Future AI outputs must be stored separately in `records`, `entities`, `relations`, and `processing_jobs`.

The bot stores a safe metadata subset instead of the entire raw Telegram update:

- chat type;
- text/caption presence;
- media group id;
- Telegram entities and caption entities;
- forward origin summary;
- reply message id.

This keeps the archive useful for later processing without blindly persisting every update field.

## Message Versioning

`messages` stores the current state keyed by `(telegram_chat_id, telegram_message_id)`. `message_versions` stores immutable received versions. A SHA-256 hash over text and metadata prevents duplicate identical versions. The first received message creates version 1. Edited messages update current state and append a new version only if the content hash changed.

## Attachments

Attachments are keyed by `telegram_file_unique_id` to avoid repeated downloads of the same Telegram file. Downloads write to a `.part` file first, enforce `MAX_ATTACHMENT_BYTES`, compute SHA-256 while streaming, then atomically rename to the final relative path.

File names are sanitized with `path.basename`, ASCII-safe replacement, MIME-based extension fallback, and a `.bin` fallback for unknown content.

## Search

MVP search uses PostgreSQL full-text search with `simple` configuration over message text/caption and attachment file names, with an `ILIKE` fallback for short or partial queries. Results are returned through `/search`.

## Future Expansion

The schema already includes placeholders for:

- bundles for grouping related source messages;
- records for structured derived notes, tasks, bookmarks, deals, and events;
- entities for people, projects, devices, services, companies, places;
- relations between source and derived objects;
- processing jobs for OCR, ASR, embeddings, previews, and LLM classification.

Future AI providers should be replaceable. Local providers are the default assumption. LLM output should be structured JSON validated by the application, never direct database writes.

## Phase 2 Preparation

Deterministic preprocessing outputs are stored as rebuildable derived artifacts, not mixed into the original Telegram source tables. The `derived_artifacts` table is keyed by `(source_kind, source_id, artifact_type, artifact_key)` and stores content plus a content hash. This gives Phase 2 a place for normalized text, extracted URLs/domains/hashtags/mentions/dates, file metadata, and safe link previews.

`processing_jobs` is the PostgreSQL-backed queue boundary for future workers. Jobs have retry limits, lock ownership, lock timestamps, and completion timestamps. Workers must claim jobs atomically with row locks and `skip locked`, write only validated derived outputs, and leave `messages`, `message_versions`, and `attachments` as the immutable source archive.
