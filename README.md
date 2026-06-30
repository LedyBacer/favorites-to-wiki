# favorites-to-wiki

Self-hosted Telegram-first personal inbox: a reliable archive for notes, links, files, media, forwards, replies, and edited messages. AI processing is intentionally out of scope for the first milestone.

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

## Development Commands

```bash
npm run typecheck
npm run lint
npm test
npm run build
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

Planned process:

1. Export Telegram “Saved Messages” from Telegram Desktop as JSON.
2. Map exported messages and files into the same source message and attachment model.
3. Preserve source metadata and versions where possible.
4. Make repeated imports idempotent.

The current importer is a scaffold only; live bot ingestion is the first milestone.

## Architecture

See [docs/architecture.md](docs/architecture.md).

Core modules:

- `src/bot` - grammY bot, commands, handlers, allowlist middleware.
- `src/domain/messages` - message save and versioning policy.
- `src/domain/attachments` - attachment download status and Telegram file handling.
- `src/storage` - local Docker-volume file storage and safe path building.
- `src/db` - Drizzle schema, client, migrations.
- `src/search` - PostgreSQL search service.
- `src/import` - Telegram Desktop export importer scaffold.

## Current Limitations

- Long polling only; no webhook server yet.
- No OCR, ASR, embeddings, LLM, reminders, web UI, or external AI calls.
- Importer is only a scaffold.
- Unit tests cover deterministic policy; full database integration tests still need a disposable PostgreSQL test harness.
- Production build uses `tsconfig.build.json`; test files are not emitted to `dist`.
