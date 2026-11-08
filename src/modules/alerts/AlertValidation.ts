import { InvalidAlertError, InvalidAlertQueryError } from "./AlertErrors";

export const DEFAULT_ALERT_LIMIT = 50;
const MAX_ALERT_LIMIT = 200;
const MESSAGE_MAX_LENGTH = 120;
const DIGITS_RE = /^\d+$/;
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const FIRING_LEVELS = ["low", "medium", "high"] as const;

export type AlertStatus = "open" | "all";

export interface AlertQuery {
  status: AlertStatus;
  limit: number;
}

/** Reads one query parameter. Absent -> undefined. Repeated or empty -> invalid. */
function read(query: Record<string, unknown>, key: string): string | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) throw new InvalidAlertQueryError(`${key} must be a single non-empty value`);
  return raw;
}

/** Validates `GET /api/alerts` params. Any bad param -> invalid_query 400 naming it. */
export function parseAlertQuery(query: Record<string, unknown>): AlertQuery {
  const out: AlertQuery = { status: "open", limit: DEFAULT_ALERT_LIMIT };
  const status = read(query, "status");
  if (status !== undefined) {
    if (status !== "open" && status !== "all") throw new InvalidAlertQueryError("status must be open or all");
    out.status = status;
  }
  const limit = read(query, "limit");
  if (limit !== undefined) {
    const n = DIGITS_RE.test(limit) ? Number(limit) : Number.NaN;
    if (!(n >= 1 && n <= MAX_ALERT_LIMIT)) throw new InvalidAlertQueryError(`limit must be an integer from 1 to ${MAX_ALERT_LIMIT}`);
    out.limit = n;
  }
  return out;
}

export interface TestFireBody {
  entityId: string;
  level: (typeof FIRING_LEVELS)[number];
  text: string;
}

/** Body of the non-production `POST /api/alerts/test-fire` hook. Anything invalid -> invalid_alert 400. */
export function parseTestFireBody(raw: unknown): TestFireBody {
  const body = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const { entityId, level, text } = body;
  if (typeof entityId !== "string" || !ENTITY_ID_RE.test(entityId)) throw new InvalidAlertError("entityId must match ^[a-z_]+\.[a-z0-9_]+$");
  if (!(FIRING_LEVELS as readonly unknown[]).includes(level)) throw new InvalidAlertError("level must be low, medium or high");
  if (typeof text !== "string" || text.length < 1 || text.length > MESSAGE_MAX_LENGTH) {
    throw new InvalidAlertError(`text must be 1 to ${MESSAGE_MAX_LENGTH} characters`);
  }
  return { entityId, level: level as TestFireBody["level"], text };
}
