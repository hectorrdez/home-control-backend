import Logger from "@utils/Logger";
import type { Queryable } from "./pool";
import { markDbUp } from "./health";

/** Delays between attempts (ms): 1s, 2s, 4s, 8s, 15s, 30s, about 60s in total. */
export const CONNECT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until `SELECT 1` succeeds. Throws the last error once the schedule is exhausted. */
export async function connectDb(db: Queryable): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await db.query("SELECT 1");
      markDbUp();
      return;
    } catch (err) {
      if (attempt >= CONNECT_RETRY_DELAYS_MS.length) throw err;
      const delay = CONNECT_RETRY_DELAYS_MS[attempt];
      Logger.write(`database not ready (${(err as Error).message}), retrying in ${delay / 1000}s`, "DB", "WARN");
      await sleep(delay);
    }
  }
}
