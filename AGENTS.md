# Project Context

## Current Goal

Build a self-hosted Telegram-first personal inbox: a reliable replacement for Telegram “Saved Messages” that stores original content, attachments, edit history, and metadata as a foundation for later local AI processing.

## Architectural Decisions

- Use Node.js 22, strict TypeScript, grammY, PostgreSQL, Drizzle ORM, Zod, Vitest, ESLint, and Prettier.
- Use Drizzle instead of Prisma because explicit PostgreSQL schema, full-text indexes, and lightweight SQL migrations matter more than generated-client ergonomics here.
- Store original Telegram source data separately from future AI-derived data.
- Never let future LLM components write directly to the database. They should produce validated structured proposals.
- Default privacy posture: no external AI providers in the MVP.
- Single-owner bot access is enforced by `TELEGRAM_ALLOWED_USER_IDS`.

## Data Model Notes

- `messages` is the mutable current state of a Telegram message keyed by `(telegram_chat_id, telegram_message_id)`.
- `message_versions` is immutable received history. Version 1 is created on first receipt. Edited messages append only if the content hash changed.
- `attachments` is keyed by `telegram_file_unique_id` to avoid duplicate downloads.
- `bundles`, `records`, `entities`, `relations`, and `processing_jobs` exist as extension points for later classification, grouping, extraction, and AI pipelines.
- Metadata is a curated JSON subset, not the full raw Telegram update.

## Storage Notes

- Telegram files are downloaded to local filesystem storage through a Docker volume.
- File paths are relative, sanitized, extension-safe, and written through `.part` files before final rename.
- `MAX_ATTACHMENT_BYTES` controls the download limit.

## MVP Behavior

- Bot accepts text, links in text, photos, documents, voice messages, videos, captions, forwards, replies, and edited messages.
- Commands: `/start`, `/help`, `/recent`, `/status`, `/search`.
- Save acknowledgements are short and can be disabled with `BOT_ACKNOWLEDGEMENTS=false`.

## Known Gaps

- Telegram Desktop export importer is currently a scaffold.
- No webhook HTTP server.
- No OCR, ASR, embeddings, Ollama, external AI, web UI, reminders, Redis, Kafka, or Kubernetes.
- Integration tests with real PostgreSQL are not yet wired; current tests focus on deterministic policy.
- Production build uses `tsconfig.build.json` so only `src` is emitted.
- The app applies bundled Drizzle migrations at startup via `drizzle-orm/node-postgres/migrator`; the production image does not depend on `drizzle-kit`.
- Docker Compose overrides `DATABASE_URL` for the app container to `postgres://favorites:favorites@postgres:5432/favorites`; `.env.example` keeps `localhost` for direct host-local development.
- The Proxmox Docker app container has been started with real Telegram credentials, and the first allowed-user text message was saved to PostgreSQL.
- `MessageService.saveTelegramMessage` uses a database transaction for source-message writes and resolves `reply_to_message_id` when the replied-to message already exists.
- The app service has a Docker healthcheck command at `dist/app/healthcheck.js` that verifies PostgreSQL and local storage.
- Real Telegram smoke test on the Proxmox deployment stored 8 messages, 9 versions, and 6 downloaded attachments with local paths and SHA-256 hashes.

## Maintenance Rule

Update this file whenever architecture, data ownership, persistence behavior, or module boundaries change materially.

Operational status, completed work, known gaps, and next implementation phases are tracked in `docs/roadmap.md`.
