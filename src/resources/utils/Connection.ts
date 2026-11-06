import "dotenv/config";
import { createPool, Pool, PoolConnection } from "mysql2/promise";

export class Connection {
  private pool: Pool;

  // The pool connects only on the first query, so importing never fails when the DB is down.
  constructor() {
    this.pool = createPool({
      host: process.env.DB_HOST ?? "127.0.0.1",
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? "app",
      password: process.env.DB_PASS,
      database: process.env.DB_NAME ?? "app",
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 100,
    });
  }

  /** Run `fn` on one connection in a transaction; commit on success, roll back on throw. */
  async transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Parameterized query; the connection is always released. */
  async execute(sql: string, values: unknown[] = []) {
    const conn = await this.pool.getConnection();
    try {
      return await conn.execute(sql, values as any[]);
    } finally {
      conn.release();
    }
  }
}

/** One shared pool for the whole process; models import this, never `new Connection()`. */
const connection = new Connection();
export default connection;
export { connection as db };
