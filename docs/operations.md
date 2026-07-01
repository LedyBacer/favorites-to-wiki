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
docker compose up -d app
docker compose ps
docker compose logs --tail=100 app
```

The app applies bundled Drizzle migrations at startup. A healthy deployment must show the app service as `healthy`.

## Diagnose Runtime State

```bash
cd /opt/favorites-to-wiki
docker compose ps
docker compose logs --tail=200 app
docker compose logs --tail=100 postgres
docker compose exec -T postgres pg_isready -U favorites -d favorites
docker compose exec -T app node dist/app/healthcheck.js
```

Startup logs include a structured `Startup summary` entry with:

- `nodeEnv`;
- `storageRoot`;
- `maxAttachmentBytes`;
- `maxAttachmentDownloadAttempts`;
- `searchResultLimit`;
- `botAcknowledgements`;
- `allowedUserCount`;
- `migrationSuccess`;
- bot identity from Telegram `getMe`.

## Attachment Retry

```bash
cd /opt/favorites-to-wiki
docker compose run --rm --entrypoint node app dist/app/retry-attachments.js 20
```

The same retry path is available from Telegram through `/retry_attachments`.

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

Defaults:

- OCR recognition model: `eslav_PP-OCRv5_mobile_rec`;
- OCR detection model: `PP-OCRv5_mobile_det`;
- ASR model: `large-v3`;
- ASR language: `ru`;
- CPU compute type: `int8`.

OCR/ASR workers must keep writing only to `derived_artifacts` and must not mutate `messages`, `message_versions`, or `attachments` except through existing source ingestion/download paths.
