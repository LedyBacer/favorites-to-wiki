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

## Bot Behavior

- Bot accepts text, links in text, photos, documents, voice messages, videos, captions, forwards, replies, and edited messages.
- Commands: `/start`, `/help`, `/recent`, `/status`, `/search`, `/retry_attachments`, `/preprocess`, `/process_media`, `/embed`, `/semantic`, `/analyze_images`, `/classify`, and `/proposals`.
- Save acknowledgements are short and can be disabled with `BOT_ACKNOWLEDGEMENTS=false`.

## Known Gaps

- No webhook HTTP server.
- No external AI providers, web UI, reminders, Redis, Kafka, or Kubernetes.
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
- `derived_artifacts` is the rebuildable storage boundary for future deterministic preprocessing outputs; do not mix derived Phase 2 data into `messages.metadata`.
- `processing_jobs` has lock ownership, lock timestamps, retry limits, and completion timestamps for future worker claim semantics.
- Phase 2 deterministic preprocessing writes `normalized_text`, `extracted_metadata`, `link_preview`, `file_metadata`, and `file_preview` artifacts. Link previews must not fetch external URLs.
- Preprocessing entry points are `/preprocess` and `npm run preprocess:run`; Docker production can run `docker compose run --rm --entrypoint node app dist/app/preprocess.js 100`.
- Roadmap phases 1.1 through 5.1 are complete and deployed.
- Phase 1.6 was deployed to the Proxmox Docker host, passed Docker healthcheck, passed PostgreSQL integration tests against a disposable database, and completed a PostgreSQL plus storage backup/restore smoke test.
- Phase 2 was deployed to the Proxmox Docker host, passed Docker healthcheck, processed production archive data into 102 derived artifacts with no failed jobs, and a repeated preprocessing run was idempotent.
- Phase 3 local OCR/ASR adds optional HTTP processor services outside the main app container. OCR jobs write `ocr_text` artifacts for downloaded images; ASR jobs write `transcript` artifacts for downloaded audio/video. Source Telegram rows remain unchanged.
- The bundled OCR service uses PaddleOCR with `eslav_PP-OCRv5_mobile_rec` by default for Russian, Belarusian, Ukrainian, English, and numbers. The bundled ASR service uses faster-whisper `large-v3` with Russian by default. Both are optional Docker Compose profiles and can be replaced by remote services through `OCR_SERVICE_URL` and `ASR_SERVICE_URL`.
- Phase 3 was deployed to the Proxmox Docker host through Git, passed Docker app healthcheck, passed PostgreSQL integration tests, built and started optional OCR/ASR containers, and completed production OCR/ASR smoke processing with 1 `ocr_text` artifact and 3 `transcript` artifacts.
- Phase 4 adds optional Ollama-compatible embeddings and semantic search. Embeddings are stored as rebuildable derived data in `embeddings` plus `derived_artifacts.embedding_reference`, not in source Telegram rows. Embedding input consumes message text plus selected `derived_artifacts` such as normalized text, OCR text, transcripts, and image descriptions.
- Phase 4 entry points are `/embed`, `/semantic`, `npm run embeddings:run`, and Docker `node dist/app/embeddings.js`.
- Phase 4 was deployed to the Proxmox Docker host through Git, passed Docker app healthcheck, passed PostgreSQL integration tests, wrote 27 production embeddings and 27 `embedding_reference` artifacts, and passed semantic search smoke testing from the production app image.
- Phase 5 local LLM classification uses an Ollama-compatible `/api/chat` provider boundary. Model output is requested with JSON Schema, validated with Zod, stored in `derived_artifacts.llm_classification`, and upserted as proposed `records`, `entities`, and `relations` with stable `proposal_key` values and `metadata.status = 'proposed'`. Model services never write directly to PostgreSQL.
- Phase 5.1 image analysis uses a multimodal Ollama-compatible model such as `qwen3.5:4b` to write rebuildable `derived_artifacts.image_description` rows for downloaded image attachments. Source Telegram rows remain unchanged. Run embedding reindexing after image analysis when semantic search should include visual content.
- Phase 5/5.1 entry points are `/classify`, `/proposals`, `/analyze_images`, `npm run classify:run`, `npm run images:analyze`, Docker `node dist/app/classify.js`, and Docker `node dist/app/image-analysis.js`.
- Phase 5/5.1 was deployed to the Proxmox Docker host through Git, passed Docker app healthcheck, passed PostgreSQL integration tests, wrote 8 production `image_description` artifacts, reindexed 28 embeddings with 8 changed vectors, and wrote 29 production `llm_classification` artifacts plus 37 proposed records with no remaining failed Phase 5 jobs.

## Maintenance Rule

Update this file whenever architecture, data ownership, persistence behavior, or module boundaries change materially.

Before starting or continuing implementation work, read the current relevant Markdown docs and treat them as the project contract:

- `AGENTS.md` for current architecture, ownership boundaries, deployment rules, and active phase context;
- `docs/roadmap.md` for completed work, phase status, exit criteria, and next planned work;
- `docs/architecture.md` for data boundaries and module responsibilities;
- `docs/operations.md` for deployment, healthcheck, backup, restore, and production command procedures;
- `README.md` for user-facing setup and command documentation.

Keep these docs current with the code. Any change that materially affects architecture, data ownership, persistence behavior, module boundaries, runtime commands, deployment, operations, or phase status must update the relevant Markdown docs in the same change.

Deployment updates to the Proxmox server must be delivered through Git: commit locally, push, then update the server with `git pull` before rebuilding/restarting Docker. Do not copy project files to the server manually as a stage-completion path.

Real Telegram Desktop export directories such as `ChatExport_*/` contain sensitive data. They must never be committed, pushed, or transferred through Git. Transfer them manually by SFTP to a temporary server path for smoke tests/imports, and remove the temporary server copy after use.

An implementation phase is not complete until the code is committed, pushed, pulled on the Proxmox deployment, and the deployed app has passed its Docker healthcheck when the phase changes runtime behavior.

Operational status, completed work, known gaps, and next implementation phases are tracked in `docs/roadmap.md`.
