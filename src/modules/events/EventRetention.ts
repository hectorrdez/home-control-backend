import Logger from "@utils/Logger";
import { pool, Queryable } from "@db/pool";

export const DEFAULT_RETENTION_DAYS = 365;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const FIRST_RUN_MS = 60_000;
const INTERVAL_MS = 60 * 60 * 1000;

/** Returns the parsed day count, or undefined when the value is set but not an integer 1..3650. */
function parseDaysStrict(raw: string): number | undefined {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= MIN_RETENTION_DAYS && n <= MAX_RETENTION_DAYS ? n : undefined;
}

/** `EVENTS_RETENTION_DAYS`: integer 1..3650. Unset, empty or invalid -> 365. */
export function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  return parseDaysStrict(raw) ?? DEFAULT_RETENTION_DAYS;
}

/** Deletes events older than the window, and acked alerts fired before it (age by fired_at). Returns the row counts. */
export async function purgeOldRows(db: Queryable, days: number): Promise<{ events: number; alerts: number }> {
  const events = await db.query("DELETE FROM events WHERE ts < now() - make_interval(days => $1)", [days]);
  const alerts = await db.query(
    "DELETE FROM alerts WHERE acked_at IS NOT NULL AND fired_at < now() - make_interval(days => $1)",
    [days]
  );
  return { events: events.rowCount ?? 0, alerts: alerts.rowCount ?? 0 };
}

/**
 * Starts the retention job: first run 1 minute after start, then hourly.
 * Failures are logged and the next run tries again. Returns a stop function.
 */
export function startEventRetention(
  opts: { db?: Queryable; days?: number } = {}
): () => void {
  const db = opts.db ?? pool;
  const raw = process.env.EVENTS_RETENTION_DAYS;
  const days = opts.days ?? parseRetentionDays(raw);
  if (opts.days === undefined && raw !== undefined && raw.trim() !== "" && parseDaysStrict(raw) === undefined) {
    Logger.write(`EVENTS_RETENTION_DAYS invalid, using ${DEFAULT_RETENTION_DAYS}`, "EVENTS", "WARN");
  }
  const run = async (): Promise<void> => {
    try {
      const deleted = await purgeOldRows(db, days);
      if (deleted.events > 0 || deleted.alerts > 0) {
        Logger.write(`retention deleted ${deleted.events} events and ${deleted.alerts} acked alerts`, "EVENTS");
      }
    } catch (err) {
      Logger.error(`retention failed: ${(err as Error)?.message ?? String(err)}`, "EVENTS");
    }
  };
  const first = setTimeout(run, FIRST_RUN_MS);
  const timer = setInterval(run, INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
