import { InvalidQueryError } from "./EventErrors";

export interface EventQuery {
  types?: string[];
  entityId?: string;
  /** ISO 8601 instant or date, as sent by the client (bound as a parameter). */
  from?: string;
  to?: string;
  /** Exclusive id cursor: only events with id < before. */
  before?: string;
  limit: number;
}

export const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_TYPES = 10;
const TYPE_RE = /^[a-z_]+$/;
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const DIGITS_RE = /^\d+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const MAX_BIGINT = 9223372036854775807n;

/** Reads one query parameter. Absent -> undefined. Repeated or empty -> invalid. */
function read(query: Record<string, unknown>, key: string): string | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.length === 0) throw new InvalidQueryError(`${key} must be a single non-empty value`);
  return raw;
}

/** ISO shape, then a real time (Date.parse rejects hour 25) and a real calendar day (Feb 30 rolls over). */
function isIsoInstant(value: string): boolean {
  if (!ISO_RE.test(value) || Number.isNaN(Date.parse(value))) return false;
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

/** Validates `GET /api/events` query params. Any bad param -> invalid_query 400 naming it. */
export function parseEventQuery(query: Record<string, unknown>): EventQuery {
  const out: EventQuery = { limit: DEFAULT_LIMIT };

  const types = read(query, "types");
  if (types !== undefined) {
    const list = types.split(",");
    if (list.length > MAX_TYPES) throw new InvalidQueryError(`types may have at most ${MAX_TYPES} values`);
    if (!list.every((t) => TYPE_RE.test(t))) throw new InvalidQueryError("types must be lowercase names matching ^[a-z_]+$");
    out.types = list;
  }

  const entityId = read(query, "entityId");
  if (entityId !== undefined) {
    if (!ENTITY_ID_RE.test(entityId)) throw new InvalidQueryError("entityId must match ^[a-z_]+\\.[a-z0-9_]+$");
    out.entityId = entityId;
  }

  const from = read(query, "from");
  if (from !== undefined && !isIsoInstant(from)) throw new InvalidQueryError("from must be an ISO 8601 date or instant");
  const to = read(query, "to");
  if (to !== undefined && !isIsoInstant(to)) throw new InvalidQueryError("to must be an ISO 8601 date or instant");
  if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
    throw new InvalidQueryError("from must be less than or equal to to");
  }
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;

  const before = read(query, "before");
  if (before !== undefined) {
    if (!DIGITS_RE.test(before) || BigInt(before) > MAX_BIGINT) {
      throw new InvalidQueryError("before must be an event id (digits only)");
    }
    out.before = before;
  }

  const limit = read(query, "limit");
  if (limit !== undefined) {
    const n = DIGITS_RE.test(limit) ? Number(limit) : Number.NaN;
    if (!(n >= 1 && n <= MAX_LIMIT)) throw new InvalidQueryError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
    out.limit = n;
  }
  return out;
}
