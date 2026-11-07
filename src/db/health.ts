import Logger from "@utils/Logger";
import type { Queryable } from "./pool";

let dbUp = false;

export const isDbUp = (): boolean => dbUp;
export const markDbUp = (): void => {
  dbUp = true;
};
export const markDbDown = (): void => {
  dbUp = false;
};

/** Pings the database every `intervalMs` and keeps the `dbUp` flag current. */
export function startDbPing(db: Queryable, intervalMs = 30000): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      await db.query("SELECT 1");
      markDbUp();
    } catch (err) {
      markDbDown();
      Logger.write(`db ping failed: ${(err as Error).message}`, "DB", "WARN");
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
