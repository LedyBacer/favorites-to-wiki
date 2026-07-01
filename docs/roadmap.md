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
- `8b0d3d9 Complete operations prep for phase 2`
- `cdd5d4d Implement deterministic preprocessing`
- `13496f4 Allow larger preprocessing batches`
- `d90696d Implement optional OCR and ASR processing`
- `d597873 Implement embeddings and semantic search`
- `6946f4e Fix optional embedding dimensions parsing`
- `f08bbf9 Fix embedding job payload typing`
- `7914694 Fix embedding vector SQL binding`
- Phase 5 work in this change adds local LLM classification plus a Phase 5.1 image-description layer.

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
- Added Telegram Desktop importer: `npm run import:telegram -- /path/to/result.json`.
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
- Added Phase 2 preparation primitives: `derived_artifacts` for rebuildable outputs and lock-aware `processing_jobs` claim semantics.
- Added Phase 2 deterministic preprocessing implementation: normalized text, extracted metadata, safe link previews, file metadata, file previews, worker CLI, and Telegram `/preprocess`.

### Partially Completed

- **Idempotent persistence:** implemented for normal repeated messages and identical edited versions. Source-message database writes are transactional, Telegram message inserts use conflict-safe insert behavior, and version writes are serialized per message with a PostgreSQL transaction advisory lock. Concurrent integration tests pass.
- **Reply linkage:** Telegram reply message ID is stored and resolved to the internal UUID when the replied-to message already exists. Backfill for unresolved older replies is not implemented.
- **Forward metadata:** the available Telegram `forward_origin` summary is stored, but no grouping or bundle inference is implemented.
- **Attachment retries:** failed downloads now track attempts and next retry time, and can be retried through Telegram or CLI. A background scheduler is intentionally deferred because manual retry is enough for the current MVP.
- **Search result quality:** search works, but ranking is still basic and result snippets are simple truncations rather than highlighted fragments.
- **Status/health:** `/status` checks database statistics and storage availability through Telegram, and the Docker app healthcheck verifies PostgreSQL plus local storage. There is still no HTTP health endpoint for external monitoring.
- **Testing:** deterministic unit tests and repository-level PostgreSQL integration tests exist. Bot handler tests are deferred to the Telegram UX phase.
- **Deployment:** Docker build, migrations, app startup, healthchecks, and real Telegram smoke tests are validated on the Proxmox Docker host.
- **Operations:** startup logging, deployment runbook, and backup/restore documentation are not complete enough to declare the first product slice done.

### Not Started By Design

These were explicitly excluded from the first phase and remain outside the current local-first scope:

- external AI providers;
- web UI;
- n8n;
- reminders;
- Redis, Kafka, Kubernetes, or microservice split.

## Key Technical Risks

### 1. Concurrent Duplicate Delivery

`MessageService.saveTelegramMessage` now wraps source-message writes in a database transaction. Concurrent duplicate delivery around the same `(telegram_chat_id, telegram_message_id)` or identical edit hash is handled and covered by integration tests; the remaining risk is regression if future persistence changes bypass the same transaction/conflict/lock pattern.

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

The current implementation avoids unsafe paths and partial final files, records download failures, and supports manual retries through Telegram and CLI entry points. The remaining operational risk is making failed media visible and recoverable during routine server maintenance.

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

Status: complete for MVP.

- Completed: improve `/search` ranking using PostgreSQL `ts_rank`.
- Completed: generate clearer result snippets and include attachment summaries.
- Completed: split long `/recent` and `/search` responses safely across multiple Telegram messages.
- Completed: improve message links:
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

Status: complete for MVP.

- Completed: define the initial supported Telegram Desktop JSON export subset for dry-run analysis.
- Completed: add dry-run parsing, unsupported-type reporting, and summary counts.
- Completed: map supported exported messages into `SaveMessageInput`-compatible records.
- Completed: map exported file/photo paths into deterministic attachment inputs for later import.
- Completed: add database import mode that writes mapped messages through `MessageService`.
- Completed: store exported local files into local storage and mark imported attachment records as downloaded.
- Completed: preserve curated export source metadata in mapped message inputs.
- Completed: make repeated import idempotent.
- Completed: add dry-run mode:

  ```bash
  npm run import:telegram -- /path/to/result.json --dry-run
  ```

- Completed: add dry-run summary counts.
- Completed: add import summary counts for database writes.
- Completed: run real Telegram Desktop export import smoke test against PostgreSQL.
- Completed: report unavailable export attachments and store them as `skipped_too_large`.

Exit criteria:

- completed: a real Telegram “Saved Messages” export can be imported repeatedly without duplicate messages;
- completed: unsupported export fields are reported, not silently discarded.

### Phase 1.6 - Observability And Operations

Priority: medium.

Status: complete.

- Completed: add an HTTP health endpoint or a small healthcheck command for Docker.
- Completed: add Docker `healthcheck` for the app service.
- Completed: add structured startup summary:
  - config mode;
  - storage root;
  - max attachment size;
  - migration success;
  - bot identity after `getMe`.
- Completed: add deployment docs for the Proxmox host:
  - project directory;
  - update command;
  - backup locations;
  - logs command;
  - restore notes.
- Completed: add backup plan:
  - PostgreSQL dump;
  - storage volume backup;
  - restore test.
- Completed: deploy Phase 1.6 to the Proxmox Docker host through Git.
- Completed: verify Docker app healthcheck after deployment.
- Completed: run PostgreSQL integration tests against a disposable `favorites_integration` database on the Proxmox PostgreSQL service.
- Completed: run backup/restore smoke test:
  - PostgreSQL custom-format dump restored into `favorites_restore_check`;
  - restored database queried successfully;
  - Telegram storage volume archived and extracted successfully;
  - temporary restore/test databases and extracted files removed.

Exit criteria:

- completed: server can be updated and diagnosed without reading source code;
- completed: backup/restore process is documented and tested once.

## Later AI-Focused Phases

Only start these after the archive layer has real data and Phase 1 persistence gaps are closed. As of this review, Phases 1.1-1.6 are complete enough for daily archive use, operations, and backup/restore. Phase 2 can start with the guardrails below.

### Readiness For Phase 2

Ready foundations:

- source messages, versions, attachments, curated metadata, and future derived entities are separated;
- `processing_jobs` exists as a PostgreSQL-backed queue table;
- `processing_jobs` has worker ownership, lock timestamps, retry limits, and completion timestamps for atomic future claims;
- `derived_artifacts` exists for normalized text, extracted metadata, file metadata, link previews, OCR text, transcripts, embedding references, LLM classification outputs, and image descriptions;
- `records`, `entities`, `relations`, and `bundles` exist as extension points;
- attachment files have stable local paths and SHA-256 values after download/import;
- no external AI provider is part of the runtime path.

Before starting Phase 2:

- completed: deploy the Phase 1.6 changes to Proxmox;
- completed: run and record one PostgreSQL plus storage backup/restore smoke test.

### Phase 2 - Deterministic Preprocessing

Status: complete.

- Completed: extract URLs, domains, hashtags, mentions, dates, and file metadata.
- Completed: generate stable normalized text per message.
- Completed: add `processing_jobs` worker loop in PostgreSQL:
  - idempotent enqueue for messages and attachments;
  - atomic claim through row locks and `skip locked`;
  - retry/backoff through existing job fields;
  - graceful shutdown for the CLI loop.
- Completed: add preview generation for links and common file types where safe:
  - link previews are URL-structure summaries only;
  - no external URL fetches are performed;
  - file previews are derived from existing attachment metadata.
- Completed: store deterministic outputs in `derived_artifacts`:
  - `normalized_text`;
  - `extracted_metadata`;
  - `link_preview`;
  - `file_metadata`;
  - `file_preview`.
- Completed: add entry points:
  - Telegram `/preprocess`;
  - `npm run preprocess:run`;
  - Docker `node dist/app/preprocess.js`.
- Completed: add unit tests for deterministic extraction and integration tests for enqueue/process/artifact idempotency.
- Completed: deploy Phase 2 to the Proxmox Docker host through Git.
- Completed: verify Docker app healthcheck after deployment.
- Completed: run PostgreSQL integration tests against a disposable `favorites_integration` database on the Proxmox PostgreSQL service.
- Completed: run production preprocessing batch:
  - 26 message jobs completed;
  - 12 attachment jobs completed;
  - 102 derived artifacts written;
  - 0 preprocessing job failures.
- Completed: run a repeated production preprocessing batch and verify it produced 0 new jobs, 0 claimed jobs, and 0 new artifacts.

Exit criteria:

- completed: deterministic processing can be run repeatedly without duplicate jobs or source row mutation;
- completed: source Telegram rows remain the immutable archive;
- completed: derived artifacts are rebuildable;
- completed: worker pattern is ready for Phase 3 OCR/ASR jobs.

### Phase 3 - Local OCR/ASR

Status: complete.

- Completed: add OCR jobs for downloaded screenshots/images through `media_ocr`.
- Completed: add transcription jobs for downloaded voice/video/audio through `media_asr`.
- Completed: store outputs as derived artifacts:
  - `ocr_text`;
  - `transcript`.
- Completed: keep source Telegram rows unchanged.
- Completed: add an app-side HTTP provider boundary so processors can run locally or on another machine.
- Completed: add optional Docker Compose `ocr` profile with a PaddleOCR service.
- Completed: default OCR recognition model to `eslav_PP-OCRv5_mobile_rec`, covering Russian, Belarusian, Ukrainian, English, and numbers.
- Completed: add optional Docker Compose `asr` profile with a faster-whisper service.
- Completed: default ASR to `large-v3`, Russian language, CPU `int8`; allow replacing with a smaller or remote model through env.
- Completed: add entry points:
  - Telegram `/process_media`;
  - `npm run media:process`;
  - Docker `node dist/app/media-process.js`.
- Completed: add unit tests for OCR/ASR candidate detection.
- Completed: deploy Phase 3 to the Proxmox Docker host through Git.
- Completed: verify Docker app healthcheck after deployment.
- Completed: verify `docker compose config` and optional OCR/ASR service startup on the Proxmox Docker host.
- Completed: build optional OCR and ASR Docker images on the Proxmox Docker host.
- Completed: start optional OCR and ASR services and verify both Docker healthchecks.
- Completed: run PostgreSQL integration tests against a disposable `favorites_integration` database on the Proxmox PostgreSQL service.
- Completed: increase the Proxmox container resource limit to 10 GB so faster-whisper `large-v3` can initialize reliably.
- Completed: run production media-processing smoke batches:
  - 1 OCR job completed;
  - 3 ASR jobs completed;
  - 1 `ocr_text` artifact written;
  - 3 `transcript` artifacts written;
  - 0 remaining Phase 3 processing job failures or pending jobs.

Exit criteria:

- completed: OCR/ASR processing can be run repeatedly without duplicate jobs or source row mutation;
- completed: optional processor containers are not built or started during normal app-only deployment;
- completed: processor URLs can point to local Compose services or another machine;
- completed: outputs are rebuildable derived artifacts;
- completed: app deployment remains healthy without OCR/ASR containers running.

### Readiness For Phase 4

Ready foundations:

- deterministic text artifacts exist for message text;
- OCR text and transcripts have the same rebuildable `derived_artifacts` boundary;
- media processing uses the existing PostgreSQL job claim/retry semantics;
- all heavy model execution is replaceable through service URLs;
- source Telegram rows remain the immutable archive.

Before starting Phase 4:

- completed: deploy Phase 3 through Git to Proxmox;
- completed: confirm normal app health without optional OCR/ASR profiles;
- completed: run OCR and ASR smoke jobs against production attachments;
- completed: record Phase 3 deployment status here.

### Phase 4 - Embeddings And Semantic Search

Status: complete.

- Completed: choose a small local embedding model:
  - `qwen3-embedding:0.6b` through Ollama by default;
  - configurable through `EMBEDDING_MODEL`.
- Completed: add an Ollama-compatible embedding provider boundary:
  - `EMBEDDING_SERVICE_URL`;
  - optional `EMBEDDING_SERVICE_API_KEY`;
  - optional `EMBEDDING_DIMENSIONS`;
  - bounded request timeout and input size.
- Completed: add embeddings as rebuildable derived data:
  - vectors are stored in `embeddings`;
  - audit/reference rows are stored as `derived_artifacts.embedding_reference`;
  - source Telegram rows remain unchanged.
- Completed: build message-level embedding input from:
  - current message text;
  - `normalized_text`;
  - attachment file names;
  - `ocr_text`;
  - `transcript`.
- Completed: add semantic search alongside PostgreSQL full-text search:
  - `/search` remains PostgreSQL full-text search;
  - `/semantic` uses embedding cosine similarity.
- Completed: keep reindexing idempotent:
  - normal runs enqueue missing jobs;
  - `--reindex` and `/embed 20 reindex` reopen jobs;
  - unchanged source content hashes are skipped.
- Completed: add entry points:
  - Telegram `/embed`;
  - Telegram `/semantic`;
  - `npm run embeddings:run`;
  - Docker `node dist/app/embeddings.js`.
- Completed: document how to connect a local neural network through Ollama, including a `qwen3-embedding:0.6b` example.

Exit criteria:

- completed: migrations apply on Proxmox;
- completed: Docker app healthcheck passes after deployment;
- completed: PostgreSQL integration tests pass against disposable `favorites_integration` on Proxmox;
- completed: production embedding batch writes embeddings with no source row mutation:
  - 27 embeddings written;
  - 27 `embedding_reference` artifacts written;
  - 0 remaining failed `message_embedding` jobs.
- completed: repeated embedding batch is idempotent:
  - 0 jobs created;
  - 0 jobs claimed;
  - 0 embeddings written.
- completed: semantic search was smoke-tested from the production app image and returned ranked results.

### Readiness For Phase 5

Phase 5 has been implemented in code and is ready for production deployment validation.

Prepared foundations:

- local Ollama connectivity is documented and configurable;
- AI/provider code is isolated behind app-owned HTTP clients;
- generated model outputs remain under app validation and persistence control;
- embeddings are rebuildable and separate from source Telegram rows;
- `processing_jobs` remains the queue/claim/retry boundary for model-backed workers.
- `records`, `entities`, and `relations` now have nullable `proposal_key` values for idempotent generated proposals.

Phase 5 guardrails:

- LLM services must not connect directly to PostgreSQL;
- model output must be validated with Zod or JSON Schema before persistence;
- classification should create proposed `records`, `entities`, and `relations`;
- review/confirmation workflows should be available through Telegram before source-derived structured data is treated as accepted.

### Phase 5 - Local LLM Classification

Status: implemented in code; deployment validation pending in this change.

- Completed: add replaceable Ollama-compatible `/api/chat` provider boundary.
- Completed: start with local Ollama and configurable `LLM_SERVICE_URL`, `LLM_MODEL`, timeout, and input-size bounds.
- Completed: validate structured JSON output with JSON Schema request constraints plus Zod validation inside the app.
- Completed: generate proposed `records`, `entities`, and `relations` without direct LLM database writes.
- Completed: store audit/rebuild output in `derived_artifacts.llm_classification`.
- Completed: add stable `proposal_key` fields for idempotent proposal upserts.
- Completed: mark generated structured rows with `metadata.status = 'proposed'`.
- Completed: add review visibility through Telegram `/proposals`.
- Completed: add entry points:
  - Telegram `/classify`;
  - Telegram `/proposals`;
  - `npm run classify:run`;
  - Docker `node dist/app/classify.js`.

Exit criteria:

- pending: migrations apply on Proxmox;
- pending: Docker app healthcheck passes after deployment;
- pending: PostgreSQL integration tests pass against disposable `favorites_integration` on Proxmox;
- pending: production classification batch writes proposed records/entities/relations with no source row mutation;
- pending: repeated classification run is idempotent unless `reclassify` is requested.

### Phase 5.1 - Image Data Layer

Status: implemented in code; deployment validation pending in this change.

- Completed: add image-analysis jobs for downloaded image attachments through `image_analysis`.
- Completed: use a multimodal Ollama-compatible vision model such as `qwen3.5:4b`.
- Completed: validate structured image JSON with JSON Schema request constraints plus Zod validation inside the app.
- Completed: store outputs as rebuildable `derived_artifacts.image_description` rows.
- Completed: include `image_description` in message embedding source text so semantic search can cover image contents after embedding reindexing.
- Completed: keep source Telegram rows unchanged.
- Completed: add entry points:
  - Telegram `/analyze_images`;
  - `npm run images:analyze`;
  - Docker `node dist/app/image-analysis.js`.

Exit criteria:

- pending: production image-analysis batch writes `image_description` artifacts with no source row mutation;
- pending: embedding reindex after image analysis includes the new visual descriptions;
- pending: repeated image-analysis run is idempotent unless `reprocess` is requested.

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
