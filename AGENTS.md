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

- No webhook HTTP server.
- No OCR, ASR, embeddings, Ollama, external AI, web UI, reminders, Redis, Kafka, or Kubernetes.
- Telegram Desktop export importer supports dry-run parsing, summary reporting, database message writes through `MessageService`, local export file storage, idempotent repeated imports, and unavailable attachment reporting through `skipped_too_large`.
- PostgreSQL integration tests exist under `tests/integration`, but they require an explicit `TEST_DATABASE_URL` and are skipped by default when that variable is not set.
- Production build uses `tsconfig.build.json` so only `src` is emitted.
- The app applies bundled Drizzle migrations at startup via `drizzle-orm/node-postgres/migrator`; the production image does not depend on `drizzle-kit`.
- Docker Compose overrides `DATABASE_URL` for the app container to `postgres://favorites:favorites@postgres:5432/favorites`; `.env.example` keeps `localhost` for direct host-local development.
- The Proxmox Docker app container has been started with real Telegram credentials, and the first allowed-user text message was saved to PostgreSQL.
- `MessageService.saveTelegramMessage` uses a database transaction for source-message writes and resolves `reply_to_message_id` when the replied-to message already exists.
- Telegram message inserts use `onConflictDoNothing` for `(telegram_chat_id, telegram_message_id)`, and version writes are serialized by a PostgreSQL transaction advisory lock per internal message ID.
- The app service has a Docker healthcheck command at `dist/app/healthcheck.js` that verifies PostgreSQL and local storage.
- Real Telegram smoke test on the Proxmox deployment stored 8 messages, 9 versions, and 6 downloaded attachments with local paths and SHA-256 hashes.
- PostgreSQL integration tests live under `tests/integration` and run with `TEST_DATABASE_URL=... npm run test:integration`.
- Attachment retries track `download_attempts`, `last_download_attempt_at`, and `next_retry_at`; retry entry points are `/retry_attachments` and `npm run attachments:retry`.
- In Docker Compose production, run attachment retry as `docker compose run --rm --entrypoint node app dist/app/retry-attachments.js 20`.
- Roadmap phases 1.1, 1.2, 1.3, 1.4, and 1.5 are complete; current planned work is Phase 1.6 observability and operations.
- Phase 2 deterministic preprocessing is not blocked by the schema, but it should wait until Phase 1.6 documents startup diagnostics, backup, restore, and deployment operations.

## Maintenance Rule

Update this file whenever architecture, data ownership, persistence behavior, or module boundaries change materially.

Deployment updates to the Proxmox server must be delivered through Git: commit locally, push, then update the server with `git pull` before rebuilding/restarting Docker. Do not copy project files to the server manually as a stage-completion path.

Real Telegram Desktop export directories such as `ChatExport_*/` contain sensitive data. They must never be committed, pushed, or transferred through Git. Transfer them manually by SFTP to a temporary server path for smoke tests/imports, and remove the temporary server copy after use.

An implementation phase is not complete until the code is committed, pushed, pulled on the Proxmox deployment, and the deployed app has passed its Docker healthcheck when the phase changes runtime behavior.

Operational status, completed work, known gaps, and next implementation phases are tracked in `docs/roadmap.md`.
