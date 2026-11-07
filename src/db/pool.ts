import { Pool, PoolClient } from "pg";
import Logger from "@utils/Logger";
import { markDbDown, markDbUp } from "./health";

/** Minimal query surface, so stores and migrations can be unit-tested with fakes. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

const parsedMax = Number(process.env.DB_POOL_MAX ?? 5);
const max = Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : 5;

// pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE from the environment itself.
export const pool = new Pool({
  max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Message only: never the connection string or PGPASSWORD.
pool.on("error", (err: Error) => {
  markDbDown();
  Logger.error(err.message, "DB");
});

export async function query(sql: string, params?: unknown[]) {
  const result = await pool.query(sql, params);
  markDbUp();
  return result;
}

/** Runs `fn` inside BEGIN/COMMIT on one client. ROLLBACK when `fn` throws; the client is always released. */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw err;
    }
  } finally {
    client.release(broken);
  }
}
