# Operations Runbook

## Proxmox Docker Host

- Host: `192.168.1.169`
- User: `root`
- Project directory: `/opt/favorites-to-wiki`
- Compose file: `/opt/favorites-to-wiki/docker-compose.yml`
- Runtime secrets: `/opt/favorites-to-wiki/.env`
- Backup directory: `/opt/favorites-to-wiki/backups`

Do not copy project files to the server manually for normal updates. Deployment changes go through Git.

## Update Deployment

```bash
cd /opt/favorites-to-wiki
git pull
docker compose build app
docker compose up -d app worker
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 worker
```

The app and worker both apply bundled Drizzle migrations at startup. A healthy deployment must show the app and worker services as `healthy`.

## Diagnose Runtime State

```bash
cd /opt/favorites-to-wiki
docker compose ps
docker compose logs --tail=200 app
docker compose logs --tail=200 worker
docker compose logs --tail=100 postgres
docker compose exec -T postgres pg_isready -U favorites -d favorites
docker compose exec -T app node dist/app/healthcheck.js
docker compose exec -T worker node dist/app/healthcheck.js
```

Startup logs include a structured `Startup summary` entry with:

- `nodeEnv`;
- `storageRoot`;
- `maxAttachmentBytes`;
- `maxAttachmentDownloadAttempts`;
- `searchResultLimit`;
- `embeddingServiceConfigured`;
- `embeddingModel`;
- `embeddingDimensions`;
- `embeddingMaxInputChars`;
  - `botAcknowledgements`;
  - `allowedUserCount`;
  - `migrationSuccess`;
  - bot identity from Telegram `getMe`.

Worker startup logs include a structured `Pipeline worker startup summary` entry with:

- `workerId`;
- batch size and idle interval;
- OCR/ASR, embedding, and LLM provider configuration flags.

Each worker loop logs `Pipeline worker loop completed` with bundle, attachment retry, preprocessing, media, embedding, image-analysis, and classification summaries. Provider-backed stages report a skipped reason when not configured. The worker writes `worker_heartbeats` rows with last loop start, last success, last error, duration, and worker ID.

## Automatic Pipeline Worker

The normal deployment runs:

```bash
cd /opt/favorites-to-wiki
docker compose up -d app worker postgres
```

The worker automatically enqueues and processes changed inputs. It reopens an existing `processing_jobs` row when `input_hash` or `generation_key` changes, so downstream embeddings and classification refresh after OCR, transcripts, or image descriptions are written.

Tune worker cadence with:

```bash
WORKER_BATCH_SIZE=25
WORKER_IDLE_MS=15000
WORKER_HEARTBEAT_MAX_AGE_MS=300000
WORKER_ATTACHMENT_RETRY_INTERVAL_MS=900000
```

The worker container sets `WORKER_HEALTHCHECK=true`, so `dist/app/healthcheck.js` fails when no successful worker cycle has been recorded within `WORKER_HEARTBEAT_MAX_AGE_MS`. The app container uses the same healthcheck script without the worker heartbeat requirement.

Manual processing commands remain useful for diagnostics, but routine use should not require Telegram processing commands.

## Attachment Retry

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/retry-attachments.js 20
```

The same retry path is available from Telegram through `/retry_attachments`.

The continuous worker also retries due pending/failed attachments automatically no more often than `WORKER_ATTACHMENT_RETRY_INTERVAL_MS`.

## Evaluation Export And Import

Export proposed classification records for manual labeling:

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/evaluation.js export classification-evaluation.json 100
```

Import reviewed annotations as audit feedback:

```bash
docker compose run --rm --entrypoint node app dist/app/evaluation.js import classification-evaluation.json
```

The import writes `review_actions` feedback rows. It does not fine-tune models, change model weights, or mutate source Telegram messages.

## Deterministic Preprocessing

Run one preprocessing batch:

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/preprocess.js 100
```

Run the worker loop manually:

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/preprocess.js 100 --loop
```

The same small batch path is available from Telegram through `/preprocess`. The worker writes only `derived_artifacts`; it does not mutate source Telegram rows.

## Backup

Create the backup directory once:

```bash
cd /opt/favorites-to-wiki
mkdir -p backups
```

Create a PostgreSQL custom-format dump and a tar archive of the Telegram file storage volume:

```bash
cd /opt/favorites-to-wiki
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
docker compose exec -T postgres pg_dump -U favorites -d favorites -Fc > "backups/postgres-${STAMP}.dump"
docker run --rm \
  -v favorites-to-wiki_telegram_files:/data:ro \
  -v /opt/favorites-to-wiki/backups:/backup \
  alpine tar -czf "/backup/telegram-files-${STAMP}.tgz" -C /data .
ls -lh "backups/postgres-${STAMP}.dump" "backups/telegram-files-${STAMP}.tgz"
```

If the Compose project name changes, confirm the volume name with:

```bash
docker volume ls | grep telegram_files
```

## Restore Test

Run restore tests without touching the production `favorites` database:

```bash
cd /opt/favorites-to-wiki
POSTGRES_DUMP="backups/postgres-YYYYMMDDTHHMMSSZ.dump"
FILES_ARCHIVE="backups/telegram-files-YYYYMMDDTHHMMSSZ.tgz"

docker compose exec -T postgres dropdb -U favorites --if-exists favorites_restore_check
docker compose exec -T postgres createdb -U favorites favorites_restore_check
docker compose exec -T postgres pg_restore -U favorites -d favorites_restore_check < "$POSTGRES_DUMP"
docker compose exec -T postgres psql -U favorites -d favorites_restore_check -c \
  "select count(*) as messages from messages; select count(*) as attachments from attachments;"
docker compose exec -T postgres dropdb -U favorites favorites_restore_check

rm -rf /tmp/favorites-storage-restore-check
mkdir -p /tmp/favorites-storage-restore-check
tar -xzf "$FILES_ARCHIVE" -C /tmp/favorites-storage-restore-check
find /tmp/favorites-storage-restore-check -type f | head
rm -rf /tmp/favorites-storage-restore-check
```

The restore test passes when `pg_restore` exits successfully, restored tables can be queried, and the storage archive extracts readable files.

## Full Restore

For a real restore, stop the app before changing production state:

```bash
cd /opt/favorites-to-wiki
docker compose stop app
docker compose exec -T postgres dropdb -U favorites --if-exists favorites
docker compose exec -T postgres createdb -U favorites favorites
docker compose exec -T postgres pg_restore -U favorites -d favorites < backups/postgres-YYYYMMDDTHHMMSSZ.dump
docker run --rm \
  -v favorites-to-wiki_telegram_files:/data \
  -v /opt/favorites-to-wiki/backups:/backup \
  alpine sh -c 'rm -rf /data/* && tar -xzf /backup/telegram-files-YYYYMMDDTHHMMSSZ.tgz -C /data'
docker compose up -d app
docker compose ps
```

## Phase 2 Operational Guardrails

Deterministic preprocessing must not write into `messages.metadata` as its primary store. Store rebuildable outputs in `derived_artifacts`, keyed by source object and artifact type. Use `processing_jobs` with atomic claim semantics before adding any background worker loop.

Future workers must:

- claim jobs with `for update skip locked`;
- set `locked_by` and `locked_at`;
- increment `attempts` before processing;
- clear locks on completion or retryable failure;
- leave original Telegram source rows unchanged.

Phase 2 link and file previews are deliberately safe and deterministic. They do not fetch external URLs. Link previews are derived from URL structure, and file previews are derived from attachment rows, MIME type, filename, local path, size, and SHA-256 availability.

## Optional OCR/ASR Services

OCR and ASR are optional Docker Compose profiles. A normal app deployment does not build or start these containers.

Start OCR locally on the Docker host:

```bash
cd /opt/favorites-to-wiki
docker compose --profile ocr up -d ocr
docker compose ps ocr
docker compose logs --tail=100 ocr
```

Start ASR locally on the Docker host:

```bash
cd /opt/favorites-to-wiki
docker compose --profile asr up -d asr
docker compose ps asr
docker compose logs --tail=100 asr
```

Run one OCR/ASR processing batch:

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/media-process.js 20 --mode=all
```

Run only OCR or only ASR:

```bash
docker compose run --rm --entrypoint node app dist/app/media-process.js 20 --mode=ocr
docker compose run --rm --entrypoint node app dist/app/media-process.js 20 --mode=asr
```

Run a continuous worker loop:

```bash
docker compose run --rm --entrypoint node app dist/app/media-process.js 20 --mode=all --loop
```

The same small batch path is available from Telegram through `/process_media`.

To run processors on another machine, deploy any service that implements the same HTTP contract and point the app environment to it:

```bash
OCR_SERVICE_URL=http://ocr-host:8000
ASR_SERVICE_URL=http://asr-host:8000
```

Optional bearer secrets can be set with `OCR_SERVICE_API_KEY` and `ASR_SERVICE_API_KEY`; the app sends them as `Authorization: Bearer ...`.

Model storage:

- PaddleOCR model cache: `ocr_models` volume;
- faster-whisper/Hugging Face cache: `asr_models` volume.

Model memory lifecycle:

- OCR and ASR models are loaded lazily on the first processing request;
- loaded model objects are unloaded from process memory after 60 seconds without OCR/ASR requests;
- tune the idle timeout with `OCR_MODEL_IDLE_UNLOAD_SECONDS` and `ASR_MODEL_IDLE_UNLOAD_SECONDS`;
- Docker volumes keep downloaded model files, so unloading memory does not delete model caches.

Defaults:

- OCR recognition model: `eslav_PP-OCRv5_mobile_rec`;
- OCR detection model: `PP-OCRv5_mobile_det`;
- ASR model: `large-v3`;
- ASR language: `ru`;
- CPU compute type: `int8`.

OCR/ASR workers must keep writing only to `derived_artifacts` and must not mutate `messages`, `message_versions`, or `attachments` except through existing source ingestion/download paths.

## Ollama Configuration

Embeddings, local LLM classification, and image analysis are optional. Configure Ollama-compatible HTTP endpoints in `.env`:

```bash
EMBEDDING_SERVICE_URL=http://192.168.1.156:11434
EMBEDDING_MODEL=qwen3-embedding:0.6b
EMBEDDING_DIMENSIONS=
EMBEDDING_SERVICE_TIMEOUT_MS=300000
EMBEDDING_MAX_INPUT_CHARS=12000
LLM_SERVICE_URL=http://192.168.1.156:11434
LLM_MODEL=qwen3.5:4b
LLM_VISION_MODEL=qwen3.5:4b
LLM_SERVICE_TIMEOUT_MS=600000
LLM_MAX_INPUT_CHARS=20000
LLM_IMAGE_MAX_ATTACHMENT_BYTES=26214400
```

## Embeddings And Semantic Search

Smoke-test Ollama from the Docker host:

```bash
curl http://192.168.1.156:11434/api/tags
curl http://192.168.1.156:11434/api/embed -d '{"model":"qwen3-embedding:0.6b","input":"semantic search test","truncate":true}'
```

Run one embedding indexing batch:

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/embeddings.js 100
```

Run a continuous worker loop:

```bash
docker compose run --rm --entrypoint node app dist/app/embeddings.js 100 --loop
```

Reopen existing jobs and rebuild only changed vectors after model/input changes:

```bash
docker compose run --rm --entrypoint node app dist/app/embeddings.js 100 --reindex
```

The same small batch path is available from Telegram through `/embed`; semantic search is available through `/semantic`.

Embedding workers write to `embeddings` plus `derived_artifacts.embedding_reference`. They must not mutate `messages`, `message_versions`, or `attachments`.

## Local LLM Classification And Image Analysis

Local LLM classification and image analysis reuse the same operational pattern as OCR/ASR and embeddings:

- configure `LLM_SERVICE_URL` in `.env`;
- run processing through `processing_jobs`;
- validate model output with Zod or JSON Schema inside the app;
- write proposed records/entities/relations as reviewable derived data;
- never allow the model service to connect directly to PostgreSQL or mutate source Telegram tables.

Smoke-test Ollama chat/vision from the Docker host:

```bash
curl http://192.168.1.156:11434/api/tags
curl http://192.168.1.156:11434/api/chat -d '{
  "model": "qwen3.5:4b",
  "messages": [{"role":"user","content":"Return {\"ok\":true} as JSON"}],
  "stream": false,
  "format": "json"
}'
```

Run one image-analysis batch:

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/image-analysis.js 20
```

Run a continuous image-analysis worker loop:

```bash
docker compose run --rm --entrypoint node app dist/app/image-analysis.js 20 --loop
```

Run one LLM classification batch:

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/classify.js 20
```

Run a continuous classification worker loop:

```bash
docker compose run --rm --entrypoint node app dist/app/classify.js 20 --loop
```

Reopen existing jobs after prompt/model changes:

```bash
docker compose run --rm --entrypoint node app dist/app/image-analysis.js 20 --reprocess
docker compose run --rm --entrypoint node app dist/app/classify.js 20 --reclassify
```

The same small batch paths are available from Telegram through `/analyze_images` and `/classify`. Recent proposed records are visible through `/proposals`.

After image analysis writes `image_description` artifacts, rerun embeddings with `--reindex` if semantic search should include visual content:

```bash
docker compose run --rm --entrypoint node app dist/app/embeddings.js 100 --reindex
```

LLM outputs are proposals. Treat rows with `metadata.status = 'proposed'` in `records`, `entities`, and `relations` as reviewable generated data, not confirmed source facts.
