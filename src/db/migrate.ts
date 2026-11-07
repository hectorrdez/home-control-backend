import Logger from "@utils/Logger";
import type { Pool } from "pg";
import type { Queryable } from "./pool";
import { migrations, Migration } from "./migrations";

/** Session advisory lock so concurrent API starts cannot apply the same migration twice. */
export const MIGRATION_LOCK_ID = 4210013;

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

const isPool = (db: Queryable | Pool): db is Pool => typeof (db as Pool).connect === "function";

/**
 * Applies every migration with a version above the highest applied one, in
 * version order. Each runs in its own BEGIN/COMMIT together with its
 * `schema_migrations` row. A failure rolls back, logs and throws; later
 * migrations are not run. Safe to call again (no-op when up to date).
 * With a Pool, one client holds the session lock for the whole run.
 */
export async function migrate(db: Queryable | Pool): Promise<void> {
  const client: Queryable & { release?: () => void } = isPool(db) ? await db.connect() : db;
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    try {
      await client.query(SCHEMA_MIGRATIONS_DDL);
      const applied = await client.query("SELECT COALESCE(MAX(version), 0) AS max FROM schema_migrations");
      const maxApplied = Number(applied.rows[0]?.max ?? 0);
      const pending = migrations
        .filter((m) => m.version > maxApplied)
        .sort((a, b) => a.version - b.version);
      for (const migration of pending) {
        await applyOne(client, migration);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  } finally {
    if (client !== db) client.release?.();
  }
}

async function applyOne(client: Queryable, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.up);
    await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
      migration.version,
      migration.name,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    Logger.error(`migration ${migration.version} ${migration.name} failed: ${(err as Error).message}`, "DB");
    throw err;
  }
}
