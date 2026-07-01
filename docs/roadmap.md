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
- real media/update smoke test passed: photos, documents, voice, video, and one edited text message were archived.

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
- Verified real Telegram media ingestion on the Proxmox deployment:
  - 8 messages stored;
  - 9 message versions stored;
  - 6 attachments downloaded;
  - all downloaded attachments have local paths and SHA-256 hashes;
  - one edited text message produced version 1 and version 2.
- Added an app container healthcheck that verifies PostgreSQL and local storage availability.
- Added PostgreSQL integration tests for migration idempotency, concurrent duplicate first delivery, concurrent identical edits, and concurrent different edits.

### Partially Completed

- **Idempotent persistence:** implemented for normal repeated messages and identical edited versions. Source-message database writes are transactional, Telegram message inserts use conflict-safe insert behavior, and version writes are serialized per message with a PostgreSQL transaction advisory lock. Concurrent integration tests pass.
- **Reply linkage:** Telegram reply message ID is stored and resolved to the internal UUID when the replied-to message already exists. Backfill for unresolved older replies is not implemented.
- **Forward metadata:** the available Telegram `forward_origin` summary is stored, but no grouping or bundle inference is implemented.
- **Attachment retries:** failed downloads now track attempts and next retry time, and can be retried through Telegram or CLI. A background scheduler is intentionally deferred because manual retry is enough for the current MVP.
- **Search result quality:** search works, but ranking is still basic and result snippets are simple truncations rather than highlighted fragments.
- **Status/health:** `/status` checks database statistics and storage availability through Telegram, and the Docker app healthcheck verifies PostgreSQL plus local storage. There is still no HTTP health endpoint for external monitoring.
- **Testing:** deterministic unit tests and repository-level PostgreSQL integration tests exist. Bot handler tests are deferred to the Telegram UX phase.
- **Deployment:** Docker build, migrations, app startup, healthchecks, and real Telegram smoke tests are validated on the Proxmox Docker host.

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

- the code now handles Telegram message identity conflicts as idempotent inserts;
- message version writes are serialized per internal message ID;
- this path is covered by integration tests that deliberately run duplicate writes in parallel.

### 2. Migration Validation

Migrations ran successfully on the remote PostgreSQL container and are covered by integration tests against a real PostgreSQL database.

Why it matters:

- Drizzle schema and handwritten SQL can drift;
- future migrations should be run in CI or local test containers as part of the integration suite.

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

Status: complete.

- Completed: replace placeholder values in `/opt/favorites-to-wiki/.env` on the server:
  - `TELEGRAM_BOT_TOKEN`;
  - `TELEGRAM_ALLOWED_USER_IDS`.
- Completed: start the app container:

  ```bash
  cd /opt/favorites-to-wiki
  docker compose up -d app
  docker compose logs -f app
  ```

- Completed: send real Telegram test messages:
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
- Completed: verify through Telegram:
  - short save acknowledgement;
  - `/recent`;
  - `/search`;
  - `/status`.
- Verify through PostgreSQL:
  - completed for the first text message: `messages` rows exist;
  - completed: `message_versions` has version 1 and edited versions;
  - completed: `attachments` rows are downloaded or correctly marked;
  - completed: storage volume contains downloaded files.

Exit criteria:

- completed: app container stays running;
- bot accepts messages only from the allowed user;
- completed for text ingestion: a real owner message is archived;
- completed: at least one attachment is downloaded with SHA-256;
- completed: editing a saved text creates one new version;
- completed by integration test: repeating the same edit does not create duplicate versions.

### Phase 1.2 - Strengthen Persistence

Priority: high.

Status: complete.

- Completed: wrap message save/version/attachment row creation in a database transaction.
- Completed: use PostgreSQL conflict-safe insert patterns for `(telegram_chat_id, telegram_message_id)` and `(message_id, content_hash)`.
- Completed: resolve `reply_to_message_id` to the internal message UUID when the target message already exists.
- Completed: add a small repository-level integration test suite against a disposable PostgreSQL instance.
- Completed: add migration smoke tests:
  - apply migrations from empty DB;
  - verify all expected tables, enums, and indexes exist;
  - verify startup migration runner is idempotent.

Exit criteria:

- completed: concurrent duplicate save tests pass;
- completed: migration tests can be run with `npm run test:integration` and `TEST_DATABASE_URL`;
- completed: reply links work for messages already present in the archive.

### Phase 1.3 - Improve Attachment Reliability

Priority: high.

Status: complete for MVP.

- Completed: add explicit retry policy for Telegram downloads:
  - max attempts;
  - exponential backoff;
  - persistent attempt count or processing job;
  - final failure reason.
- Completed: add command and CLI to retry failed attachments.
- Completed: avoid re-downloading a file when a downloaded attachment with the same `telegram_file_unique_id` already has a local path and SHA-256.
- Completed: verify the production Docker retry entry point on the Proxmox host.
- Completed: add integration tests for:
  - too-large files;
  - partial download cleanup;
  - duplicate unique file ID;
  - unknown extension fallback.
- Decision: do not store Telegram `file_path` yet. It is a transient Bot API download path and can be reacquired with `getFile` when retrying.

Exit criteria:

- completed: transient download failure can recover through retry command/CLI;
- completed: duplicate file sends create separate attachment rows without duplicate local downloads;
- completed: failed attachment state is actionable.

### Phase 1.4 - Better Search And Telegram UX

Priority: medium.

- Completed: improve `/search` ranking using PostgreSQL `ts_rank`.
- Completed: generate clearer result snippets and include attachment summaries.
- Completed: split long `/recent` and `/search` responses safely across multiple Telegram messages.
- Improve message links:
  - keep `t.me/c/...` for supergroups/channels where valid;
  - avoid misleading links for private chats where Telegram cannot form a public URL.
- Completed: add `limit` support for `/recent` and `/search`.
- Completed: localize core bot command responses consistently in Russian.
- Completed: run real Telegram smoke test for the updated search UX on the Proxmox deployment.

Exit criteria:

- search results are useful with real saved data;
- long result sets do not exceed Telegram message limits;
- command text is consistent and predictable.

### Phase 1.5 - Telegram Desktop Export Import

Priority: medium.

- Completed: define the initial supported Telegram Desktop JSON export subset for dry-run analysis.
- Completed: add dry-run parsing, unsupported-type reporting, and summary counts.
- Completed: map supported exported messages into `SaveMessageInput`-compatible records.
- Completed: map exported file/photo paths into deterministic attachment inputs for later import.
- Map exported files into attachment records.
- Completed: preserve curated export source metadata in mapped message inputs.
- Make repeated import idempotent.
- Completed: add dry-run mode:

  ```bash
  npm run import:telegram -- /path/to/result.json --dry-run
  ```

- Completed: add dry-run summary counts.
- Add import progress logging for database writes.

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
