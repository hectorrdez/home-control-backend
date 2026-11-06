import { db } from "@utils/Connection";

/**
 * Thin base for module models: raw parameterized SQL without the
 * `[rows] = await ...` boilerplate.
 */
export default abstract class Repository {
  protected readonly db = db;

  /** All matching rows. */
  protected async many<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.db.execute(sql, params);
    return (rows as unknown as T[]) ?? [];
  }

  /** First matching row, or null. */
  protected async one<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.many<T>(sql, params);
    return rows.length ? rows[0] : null;
  }

  /** Run a write; returns the raw mysql2 result header (`insertId`, `affectedRows`). */
  protected async exec(sql: string, params: unknown[] = []): Promise<any> {
    const [result] = await this.db.execute(sql, params);
    return result;
  }
}
