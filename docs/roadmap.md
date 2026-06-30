# Roadmap

## Current Status

The project has a working first-pass Telegram-first inbox MVP. The codebase is no longer an empty repository: it has a TypeScript/Node.js application, grammY bot integration, PostgreSQL schema and migrations, Docker Compose deployment, local file storage, tests for deterministic logic, and project documentation.

The remote Docker host was also validated:

- repository cloned to `/opt/favorites-to-wiki`;
- app image built successfully;
- PostgreSQL service started and reported healthy;
- bundled migrations ran successfully from the app image;
- app service started with production Telegram credentials;
- the first backlog Telegram text message from the allowed owner was ingested and stored in PostgreSQL.

Latest committed work on `main`:

- `3fce1b1 Build Telegram inbox MVP`
- `d675c2d Run database migrations on startup`
- `8728523 Fix Docker database URL`
- `87a3dcb Document project roadmap`

## Review Against The Original Plan

### Completed

- Created a TypeScript/Node.js 22 project with strict TypeScript settings.
- Chose Drizzle ORM over Prisma and documented the reason.
- Added grammY as the Telegram bot framework.
- Added PostgreSQL schema, migration SQL, and Drizzle schema definitions.
- Added Docker Compose with PostgreSQL, app container, persistent PostgreSQL volume, and Telegram file storage volume.
- Added Zod-based environment validation.
- Added allowlist access control through `TELEGRAM_ALLOWED_USER_IDS`.
- Added short save acknowledgements controlled by `BOT_ACKNOWLEDGEMENTS`.
- Added message ingestion for text, captions, photos, documents, voice messages, videos, forwards, replies, and edited messages.
- Added current message state in `messages`.
- Added immutable message history in `message_versions`.
- Added duplicate version prevention through a SHA-256 content hash.
- Added attachment records with Telegram file IDs, unique IDs, original file names, MIME type, size, local path, SHA-256, and download status.
- Added local file download with safe path construction, `.part` files, SHA-256 streaming, and max-size enforcement.
- Added `/start`, `/help`, `/recent`, `/status`, and `/search`.
- Added PostgreSQL full-text search plus `ILIKE` fallback over message text/captions and attachment names.
- Added placeholder tables for `bundles`, `records`, `entities`, `relations`, and `processing_jobs`.
- Added importer command scaffold: `npm run import:telegram -- /path/to/result.json`.
- Added `docs/architecture.md`, `AGENTS.md`, and README setup/deployment instructions.
- Added unit tests for allowlist, attachment path safety, and message versioning policy.
- Added runtime migration execution so the production image does not depend on `drizzle-kit`.
- Added `tsconfig.build.json` so production builds emit only runtime source files.
- Started the app container on the Proxmox Docker host with real Telegram credentials.
- Verified that a real Telegram text message from the allowed owner was saved to PostgreSQL.
- Added an app container healthcheck that verifies PostgreSQL and local storage availability.

### Partially Completed

- **Idempotent persistence:** implemented for normal repeated messages and identical edited versions; source-message database writes are transactional, but the path has not yet been stress-tested for concurrent duplicate updates.
- **Reply linkage:** Telegram reply message ID is stored and resolved to the internal UUID when the replied-to message already exists. Backfill for unresolved older replies is not implemented.
- **Forward metadata:** the available Telegram `forward_origin` summary is stored, but no grouping or bundle inference is implemented.
- **Attachment retries:** failed downloads are marked as `failed`, but there is no retry scheduler, backoff, or CLI/admin command to retry them.
- **Search result quality:** search works, but ranking is still basic and result snippets are simple truncations rather than highlighted fragments.
- **Status/health:** `/status` checks database statistics and storage availability through Telegram, and the Docker app healthcheck verifies PostgreSQL plus local storage. There is still no HTTP health endpoint for external monitoring.
- **Testing:** deterministic unit tests exist, but integration tests with real PostgreSQL, migration verification, and bot handler tests are still missing.
- **Deployment:** Docker build and migration were validated on the Proxmox Docker host, but app startup with a real Telegram token is pending.

### Not Started By Design

These were explicitly excluded from the first phase and should remain out until the archive layer is stable:

- Ollama and local LLM integration;
- OCR;
- Whisper or other ASR;
- embeddings and vector search;
- external AI providers;
- web UI;
- n8n;
- reminders;
- Redis, Kafka, Kubernetes, or microservice split;
- automatic classification and structured record generation.

## Key Technical Risks

### 1. Concurrent Duplicate Delivery

`MessageService.saveTelegramMessage` now wraps source-message writes in a database transaction. The remaining risk is concurrent duplicate delivery around the same `(telegram_chat_id, telegram_message_id)` or identical edit hash.

Why it matters:

- concurrent Telegram deliveries could race;
- a unique constraint conflict should be handled as idempotent behavior, not as an avoidable bot error;
- this path needs tests that deliberately run duplicate writes in parallel.

### 2. Migration Validation

Migrations ran successfully on the remote PostgreSQL container, but local automated integration coverage is still missing.

Why it matters:

- Drizzle schema and handwritten SQL can drift;
- future migrations need repeatable validation in CI or local test containers.

### 3. Attachment Download Lifecycle

The current implementation avoids unsafe paths and partial final files, but download failures are only recorded.

Why it matters:

- Telegram API/network failures are normal;
- large media and home-server network conditions require retry/backoff;
- downloaded files should be auditable and recoverable.

### 4. Telegram API Edge Cases

The parser supports the required MVP message types, but Telegram updates have many variants: albums, paid media, channel posts, anonymous admins, messages without `from`, protected forwards, edited captions, and large documents.

Why it matters:

- unsupported variants should degrade into `unknown` without losing useful metadata;
- private single-owner use reduces the blast radius, but forwarded work context can still be diverse.

### 5. Operational Secrets

No secrets are committed. The remote server now has a real `.env`, but it must remain out of Git and logs.

Why it matters:

- deployment docs should keep secrets out of Git and logs.

## Next Actions

### Phase 1.1 - Make The MVP Operational

Priority: highest.

- Completed: replace placeholder values in `/opt/favorites-to-wiki/.env` on the server:
  - `TELEGRAM_BOT_TOKEN`;
  - `TELEGRAM_ALLOWED_USER_IDS`.
- Completed: start the app container:

  ```bash
  cd /opt/favorites-to-wiki
  docker compose up -d app
  docker compose logs -f app
  ```

- Send real Telegram test messages:
  - text;
  - link;
  - photo;
  - document;
  - voice;
  - video;
  - captioned media;
  - forwarded message;
  - reply;
  - edited message.
- Verify through Telegram:
  - short save acknowledgement;
  - `/recent`;
  - `/search`;
  - `/status`.
- Verify through PostgreSQL:
  - completed for the first text message: `messages` rows exist;
  - `message_versions` has version 1 and edited versions;
  - `attachments` rows are downloaded or correctly marked;
  - storage volume contains downloaded files.

Exit criteria:

- completed: app container stays running;
- bot accepts messages only from the allowed user;
- completed for text ingestion: a real owner message is archived;
- at least one attachment is downloaded with SHA-256;
- editing a saved text creates one new version and repeating the same edit does not create duplicates.

### Phase 1.2 - Strengthen Persistence

Priority: high.

- Completed: wrap message save/version/attachment row creation in a database transaction.
- Use PostgreSQL upsert patterns more aggressively for `(telegram_chat_id, telegram_message_id)` and `(message_id, content_hash)`.
- Completed: resolve `reply_to_message_id` to the internal message UUID when the target message already exists.
- Add a small repository-level integration test suite against a disposable PostgreSQL instance.
- Add migration smoke tests:
  - apply migrations from empty DB;
  - verify all expected tables, enums, and indexes exist;
  - verify startup migration runner is idempotent.

Exit criteria:

- concurrent duplicate save tests pass;
- migration tests can be run locally with one command;
- reply links work for messages already present in the archive.

### Phase 1.3 - Improve Attachment Reliability

Priority: high.

- Add explicit retry policy for Telegram downloads:
  - max attempts;
  - exponential backoff;
  - persistent attempt count or processing job;
  - final failure reason.
- Add command or CLI to retry failed attachments.
- Avoid re-downloading a file when a downloaded attachment with the same `telegram_file_unique_id` already has a local path and SHA-256.
- Add integration tests for:
  - too-large files;
  - partial download cleanup;
  - duplicate unique file ID;
  - unknown extension fallback.
- Consider storing original Telegram `file_path` from `getFile` as download metadata if useful for debugging.

Exit criteria:

- transient download failure can recover automatically;
- duplicate file sends do not create duplicate local files;
- failed attachment state is actionable.

### Phase 1.4 - Better Search And Telegram UX

Priority: medium.

- Improve `/search` ranking using PostgreSQL `ts_rank`.
- Generate clearer result snippets and include attachment summaries.
- Split long search responses safely across multiple Telegram messages.
- Improve message links:
  - keep `t.me/c/...` for supergroups/channels where valid;
  - avoid misleading links for private chats where Telegram cannot form a public URL.
- Add pagination or `limit` support for `/recent` and `/search`.
- Localize bot responses consistently. Current responses are mixed English/Russian.

Exit criteria:

- search results are useful with real saved data;
- long result sets do not exceed Telegram message limits;
- command text is consistent and predictable.

### Phase 1.5 - Telegram Desktop Export Import

Priority: medium.

- Define supported Telegram Desktop JSON export subset.
- Parse exported messages into the same message model.
- Map exported files into attachment records.
- Preserve export source metadata without storing unsafe raw blobs.
- Make repeated import idempotent.
- Add dry-run mode:

  ```bash
  npm run import:telegram -- /path/to/result.json --dry-run
  ```

- Add progress logging and summary counts.

Exit criteria:

- a real Telegram “Saved Messages” export can be imported repeatedly without duplicate messages;
- unsupported export fields are reported, not silently discarded.

### Phase 1.6 - Observability And Operations

Priority: medium.

- Add an HTTP health endpoint or a small healthcheck command for Docker.
- Completed: add Docker `healthcheck` for the app service.
- Add structured startup summary:
  - config mode;
  - storage root;
  - max attachment size;
  - migration success;
  - bot identity after `getMe`.
- Add deployment docs for the Proxmox host:
  - project directory;
  - update command;
  - backup locations;
  - logs command;
  - restore notes.
- Add backup plan:
  - PostgreSQL dump;
  - storage volume backup;
  - restore test.

Exit criteria:

- server can be updated and diagnosed without reading source code;
- backup/restore process is documented and tested once.

## Later AI-Focused Phases

Only start these after the archive layer has real data and Phase 1 persistence gaps are closed.

### Phase 2 - Deterministic Preprocessing

- Extract URLs, domains, hashtags, mentions, dates, and file metadata.
- Generate stable normalized text per message.
- Add `processing_jobs` worker loop in PostgreSQL.
- Add preview generation for links and common file types where safe.

### Phase 3 - Local OCR/ASR

- Add OCR jobs for screenshots/images.
- Add transcription jobs for voice/video audio.
- Store outputs as derived artifacts, not as replacements for original messages.
- Keep all processing local by default.

### Phase 4 - Embeddings And Semantic Search

- Choose a small local embedding model.
- Add embeddings as derived data.
- Add semantic search alongside PostgreSQL full-text search.
- Keep reindexing idempotent.

### Phase 5 - Local LLM Classification

- Add replaceable AI provider boundary.
- Start with local Ollama.
- Validate structured JSON output with Zod/JSON Schema.
- Generate proposed records/entities/relations without direct LLM database writes.
- Add confirmation or review workflows through Telegram.

## Definition Of Done For The First Product Slice

The first product slice should be considered complete when:

- the bot runs continuously on the home server;
- owner-only access is verified;
- real Telegram messages and attachments are reliably archived;
- edits produce immutable versions;
- search and recent commands are useful in daily use;
- failed downloads can be retried;
- database migrations are covered by integration tests;
- backup and restore are documented;
- no external AI service is required or called.
