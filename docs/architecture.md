# Architecture

## Goal

The first milestone is a reliable Telegram-first personal inbox. The system stores original Telegram messages and files with enough metadata to support local AI processing. Heavy OCR/ASR, embedding generation, classification, and image analysis are optional and isolated behind local or self-hosted processor services.

## Stack Decisions

- Node.js 22 and strict TypeScript for a small, self-hosted service with predictable runtime behavior.
- grammY for Telegram Bot API integration because it has first-class TypeScript support and a small long-polling setup.
- PostgreSQL as the canonical store for messages, versions, attachments, future records, entities, relations, and processing jobs.
- Drizzle ORM instead of Prisma because this project benefits from explicit SQL-friendly schema control, PostgreSQL full-text indexes, lightweight migrations, and no generated client lifecycle.
- Local filesystem storage behind a Docker volume for Telegram files. The database stores relative paths, SHA-256 hashes, Telegram file IDs, and download status.
- Zod validates environment configuration at startup.
- Vitest covers critical deterministic logic.
- Ollama-compatible HTTP APIs provide optional local semantic search, structured classification, and image analysis.

## Data Boundaries

Original Telegram content is stored in `messages`, `message_versions`, and `attachments`. AI and deterministic outputs must be stored separately in `derived_artifacts`, `embeddings`, `records`, `entities`, `relations`, and `processing_jobs`.

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

## Full-Text Search

MVP search uses PostgreSQL full-text search with `simple` configuration over message text/caption and attachment file names, with an `ILIKE` fallback for short or partial queries. Results are returned through `/search`.

## Phase 4 Embeddings And Semantic Search

Phase 4 adds optional Ollama-compatible embeddings for semantic search. The app builds a message-level embedding input from:

- current message text;
- `normalized_text` artifacts when available;
- attachment file names;
- selected attachment artifacts such as `ocr_text`, `transcript`, and `image_description`.

The embedding vector is stored in the `embeddings` table as rebuildable derived data keyed by `(source_kind, source_id, provider, model)`. A matching `derived_artifacts.embedding_reference` row stores the provider, model, dimensions, and source content hash for auditability. Source Telegram rows remain unchanged.

The first implementation uses PostgreSQL `double precision[]` arrays and cosine similarity, avoiding a required `pgvector` extension on the home server. This is suitable for the current personal archive scale and can be migrated to `pgvector` later if ranking speed becomes a real bottleneck.

Job type:

- `message_embedding` for `messages`.

Entry points:

- Telegram `/embed`;
- `npm run embeddings:run`;
- Docker `node dist/app/embeddings.js`;
- Telegram `/semantic` for semantic search.

Embedding reindexing is idempotent. Normal runs enqueue missing message jobs. Explicit `--reindex` or `/embed 20 reindex` reopens existing embedding jobs; unchanged source hashes are skipped, and changed inputs overwrite rebuildable embedding rows.

When Phase 5.1 image descriptions are added or changed, run embedding reindexing so semantic search can include visual descriptions.

## Current Extension Points

The schema includes active extension points for:

- bundles for grouping related source messages;
- records for proposed or accepted structured notes, tasks, bookmarks, deals, files, knowledge, ideas, and events;
- entities for people, projects, devices, services, companies, places, and other named concepts;
- relations between source and derived objects;
- processing jobs for deterministic preprocessing, OCR, ASR, embeddings, image analysis, and LLM classification.

Future AI providers should be replaceable. Local providers are the default assumption. LLM output should be structured JSON validated by the application, never direct database writes. Classification results are proposals in derived/structured tables rather than direct mutations of source Telegram rows.

## Phase 6 Automatic Worker And Bundles

Phase 6 productizes the existing processing layers through a continuously running `worker` service in Docker Compose. The worker uses the same app image as the Telegram bot and runs:

```text
message ingestion
-> deterministic preprocessing
-> configured OCR/ASR and image analysis
-> configured embeddings
-> configured LLM classification
```

The worker still uses `processing_jobs` as the durable queue. Jobs keep the unique `(type, subject_kind, subject_id)` identity, and Phase 6 adds:

- `input_hash` for the current source/provider input;
- `generation_key` for the processor/model/prompt generation.

When a source row, derived media artifact, model, or prompt generation changes, the existing job is reopened instead of creating a duplicate. This lets OCR/transcript/image-description changes automatically refresh embeddings and classification without a manual `/embed reindex` or `/classify reclassify`.

Provider-backed stages are skipped when their service URL is not configured. Skipping does not fail the pipeline.

Bundles are rebuildable derived groupings over source messages. The auto-bundle service deletes and recreates only bundles where `metadata.createdBy = "auto_bundle_service"` and never mutates source message rows. Conservative deterministic grouping rules are applied in this order:

- Telegram media groups with the same chat and `mediaGroupId`;
- reply-linked messages when the replied-to source message is already known;
- sequential forwarded messages from the same forward source within 10 minutes;
- owner text followed by an attachment within 3 minutes;
- owner message bursts within 5 minutes, capped at 10 messages.

The first implementation only creates bundles with at least two messages and avoids assigning one message to multiple auto-bundles.

Classification can target either a standalone message or an auto-bundle. Bundle context includes bundle messages in chronological order, available forward metadata, OCR/transcript/image descriptions, and a small number of already indexed semantic neighbors when embeddings exist. The model still receives bounded context, not the whole database.

## Phase 5 Local LLM Classification

Phase 5 uses an Ollama-compatible `/api/chat` provider boundary. The model receives archive context built by the app from message text, deterministic artifacts, OCR, transcripts, attachment metadata, and image descriptions. The model returns structured JSON, constrained by a JSON Schema request and validated again with Zod inside the app.

Job type:

- `llm_classification` for `messages`.

Outputs:

- `derived_artifacts.llm_classification` stores the validated model proposal and source content hash for audit/rebuild;
- proposed `records`, `entities`, and `relations` are upserted with stable `proposal_key` values;
- proposal rows carry `metadata.status = "proposed"`, provider/model metadata, confidence, and source content hash.

The LLM service has no database credentials and never writes to PostgreSQL directly. Reclassification is explicit through `--reclassify` or `/classify 10 reclassify`.

Entry points:

- Telegram `/classify`;
- Telegram `/proposals`;
- `npm run classify:run`;
- Docker `node dist/app/classify.js`.

## Phase 5.1 Image Data Layer

Phase 5.1 adds a derived layer for downloaded images using a multimodal Ollama-compatible vision model such as `qwen3.5:4b`. The app reads local image bytes from `STORAGE_ROOT`, sends base64 images to `/api/chat`, validates structured JSON, and writes an `image_description` artifact.

Job type:

- `image_analysis` for downloaded image `attachments`.

Artifact type:

- `image_description`.

The artifact contains a text description, visible text, language hint, objects, tags, safety notes, confidence, provider/model metadata, and source attachment metadata. It is rebuildable and does not mutate `messages`, `message_versions`, or `attachments`. Message embeddings consume `image_description`, so `/embed --reindex` should be run after image analysis when semantic search should include visual content.

Entry points:

- Telegram `/analyze_images`;
- `npm run images:analyze`;
- Docker `node dist/app/image-analysis.js`.

## Phase 2 Preparation

Deterministic preprocessing outputs are stored as rebuildable derived artifacts, not mixed into the original Telegram source tables. The `derived_artifacts` table is keyed by `(source_kind, source_id, artifact_type, artifact_key)` and stores content plus a content hash. This gives Phase 2 a place for normalized text, extracted URLs/domains/hashtags/mentions/dates, file metadata, and safe link previews.

`processing_jobs` is the PostgreSQL-backed queue boundary for future workers. Jobs have retry limits, lock ownership, lock timestamps, and completion timestamps. Workers must claim jobs atomically with row locks and `skip locked`, write only validated derived outputs, and leave `messages`, `message_versions`, and `attachments` as the immutable source archive.

## Deterministic Preprocessing

Phase 2 adds deterministic preprocessing without AI providers. It extracts URLs, domains, hashtags, Telegram-style mentions, simple dates, normalized text, attachment file metadata, and safe previews. Safe previews intentionally do not fetch remote URLs; link previews are URL-structure summaries, and file previews are based on existing attachment metadata.

Preprocessing jobs use two job types:

- `deterministic_message_preprocess` for `messages`;
- `deterministic_attachment_preprocess` for `attachments`.

The worker upserts artifacts idempotently into `derived_artifacts`:

- `normalized_text`;
- `extracted_metadata`;
- `link_preview`;
- `file_metadata`;
- `file_preview`.

This prepares Phase 3 OCR/ASR by establishing the worker pattern and artifact boundary before any heavier local media processing is introduced.

## Phase 3 OCR/ASR

Phase 3 keeps OCR and speech recognition outside the main Node.js app container. The app enqueues and claims PostgreSQL `processing_jobs`, reads already downloaded local attachments from `STORAGE_ROOT`, sends the file bytes to an HTTP processor, and stores validated results in `derived_artifacts`.

Job types:

- `media_ocr` for downloaded image attachments;
- `media_asr` for downloaded audio and video attachments.

Artifact types:

- `ocr_text`;
- `transcript`.

The source Telegram tables remain unchanged. OCR/ASR outputs are rebuildable derived artifacts keyed to the source attachment. The processor URL is configurable, so the OCR or ASR service can run in Docker Compose on the same host or on a separate, more powerful machine.

The bundled optional processor containers are:

- PaddleOCR for OCR, defaulting to `eslav_PP-OCRv5_mobile_rec` for Russian, Belarusian, Ukrainian, English, and numbers;
- faster-whisper for ASR, defaulting to `large-v3`, CPU `int8`, and Russian transcription.

The application boundary is a small HTTP contract:

- `POST /ocr` with multipart `file`, returning `{ text, language, model, lines }`;
- `POST /transcribe` with multipart `file`, returning `{ text, language, languageProbability, durationSeconds, model, segments }`.

Phase 4 embeddings should consume source text plus selected derived artifacts through this same rebuildable boundary instead of writing embedding data into source Telegram rows.
