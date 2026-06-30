import { sql } from "drizzle-orm";
import { loadConfig } from "../config/env.js";
import { createDatabase } from "../db/client.js";
import { LocalStorage } from "../storage/local-storage.js";

const config = loadConfig();
const database = createDatabase(config.DATABASE_URL);

try {
  await database.db.execute(sql`select 1`);
  await new LocalStorage(config.STORAGE_ROOT).ensureReady();
  await database.close();
  process.exit(0);
} catch (error) {
  await database.close().catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
