# favorites-to-wiki

Self-hosted Telegram-first personal inbox: a reliable archive for notes, links, files, media, forwards, replies, and edited messages. Heavy OCR/ASR processing is optional and runs through separate local HTTP services.

## Requirements

- Node.js 22+
- npm
- Docker and Docker Compose
- Telegram bot token from BotFather

## Local Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `TELEGRAM_BOT_TOKEN` - token from BotFather.
- `TELEGRAM_ALLOWED_USER_IDS` - comma-separated Telegram user IDs allowed to use the bot.
- `DATABASE_URL` - PostgreSQL connection string.
- `STORAGE_ROOT` - local file storage directory.
- `MAX_ATTACHMENT_BYTES` - max Telegram file size to download.
- `BOT_ACKNOWLEDGEMENTS` - set `false` to disable save confirmations.
- `OCR_SERVICE_URL` - optional OCR HTTP service URL.
- `ASR_SERVICE_URL` - optional ASR HTTP service URL.

Start PostgreSQL:

```bash
docker compose up -d postgres
```

Run migrations:

```bash
npm run db:migrate
```

Run the bot locally:

```bash
npm run dev
```

## Docker Compose

Create `.env` from `.env.example`, then:

```bash
docker compose up --build
```

PostgreSQL data is stored in the `postgres_data` volume. Telegram files are stored in the `telegram_files` volume mounted at `/app/data/storage`.

`docker-compose.yml` overrides `DATABASE_URL` for the app container to use the `postgres` service hostname. Keep `.env` with `localhost` when running the bot directly on the host.

Optional OCR and ASR services are behind Docker Compose profiles and are not built or started by the normal app deployment:

```bash
docker compose --profile ocr up -d ocr
docker compose --profile asr up -d asr
```

The OCR service defaults to PaddleOCR with `eslav_PP-OCRv5_mobile_rec`, covering Russian, Belarusian, Ukrainian, English, and numbers. The ASR service defaults to faster-whisper `large-v3` with Russian transcription. Model caches live in `ocr_models` and `asr_models` volumes. `OCR_SERVICE_URL` and `ASR_SERVICE_URL` can point to another machine instead of the local Compose services.

OCR and ASR models are loaded lazily on the first processing request and unloaded from memory after 60 seconds of inactivity by default. Tune this with `OCR_MODEL_IDLE_UNLOAD_SECONDS` and `ASR_MODEL_IDLE_UNLOAD_SECONDS`.

## Telegram Bot Setup

1. Open Telegram and message `@BotFather`.
2. Run `/newbot`.
3. Copy the token into `TELEGRAM_BOT_TOKEN`.
4. Send a message to your bot after it starts.

To find your Telegram user ID, message `@userinfobot` or temporarily inspect the bot logs after sending a message. Put the numeric ID into `TELEGRAM_ALLOWED_USER_IDS`.

## Bot Commands

- `/start` - basic startup message.
- `/help` - command summary.
- `/recent` - last saved items.
- `/status` - PostgreSQL, storage, and basic stats.
- `/search query` - PostgreSQL full-text search over message text/captions and file names.
- `/retry_attachments` - retry failed or pending attachment downloads that are due.
- `/preprocess` - enqueue and run a small deterministic preprocessing batch.
- `/process_media` - enqueue and run a small OCR/ASR batch.
- `/process_media 10 ocr` - OCR-only batch.
- `/process_media 10 asr` - ASR-only batch.

## Development Commands

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
npm run attachments:retry
npm run preprocess:run
npm run media:process
```

In Docker Compose production, run the compiled retry entry point inside the app image:

```bash
docker compose run --rm --entrypoint node app dist/app/retry-attachments.js 20
```

Run deterministic preprocessing once:

```bash
npm run preprocess:run -- 100
```

Run the compiled preprocessing worker in Docker Compose:

```bash
docker compose run --rm --entrypoint node app dist/app/preprocess.js 100
```

Run it as a loop when you want a continuously draining worker:

```bash
docker compose run --rm --entrypoint node app dist/app/preprocess.js 100 --loop
```

Run optional OCR/ASR processing once:

```bash
npm run media:process -- 20 --mode=all
```

Run the compiled media worker in Docker Compose:

```bash
docker compose run --rm --entrypoint node app dist/app/media-process.js 20 --mode=all
```

Run it as a loop:

```bash
docker compose run --rm --entrypoint node app dist/app/media-process.js 20 --mode=all --loop
```

`npm run test:integration` requires a PostgreSQL database URL:

```bash
TEST_DATABASE_URL=postgres://favorites:favorites@localhost:5432/favorites_integration npm run test:integration
```

Generate Drizzle migrations after schema changes:

```bash
npm run db:generate
```

Apply migrations:

```bash
npm run db:migrate
```

The application also applies bundled Drizzle migrations on startup, so Docker Compose deployment does not require `drizzle-kit` inside the production image.

## Telegram Export Import

Importer entry point:

```bash
npm run import:telegram -- /path/to/result.json
```

Dry-run summary:

```bash
npm run import:telegram -- /path/to/result.json --dry-run
```

Supported import flow:

1. Export Telegram “Saved Messages” from Telegram Desktop as JSON.
2. Map supported exported messages and files into the same source message and attachment model.
3. Preserve curated export metadata.
4. Store local exported files into the configured storage root.
5. Make repeated imports idempotent.

## Architecture

See [docs/architecture.md](docs/architecture.md).

Project status and next steps are tracked in [docs/roadmap.md](docs/roadmap.md).
Operations, backup, restore, and Proxmox deployment commands are tracked in [docs/operations.md](docs/operations.md).

Core modules:

- `src/bot` - grammY bot, commands, handlers, allowlist middleware.
- `src/domain/messages` - message save and versioning policy.
- `src/domain/attachments` - attachment download status and Telegram file handling.
- `src/storage` - local Docker-volume file storage and safe path building.
- `src/db` - Drizzle schema, client, migrations.
- `src/search` - PostgreSQL search service.
- `src/import` - Telegram Desktop export importer.
- `src/domain/processing` - PostgreSQL processing job claim/lock primitives for future workers.
- `src/domain/preprocessing` - deterministic normalized text, metadata, safe preview, and file metadata artifacts.
- `src/domain/media-processing` - optional OCR/ASR job enqueueing, external processor clients, and derived artifacts.

## Current Limitations

- Long polling only; no webhook server yet.
- No embeddings, LLM, reminders, web UI, or external AI calls.
- OCR/ASR require optional local or remote HTTP processor services.
- Integration tests require `TEST_DATABASE_URL` and are skipped by default when that variable is not set.
- Production build uses `tsconfig.build.json`; test files are not emitted to `dist`.
