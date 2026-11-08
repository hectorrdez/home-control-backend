import Logger from "@utils/Logger";
import { pool, Queryable } from "@db/pool";
import { appEvents } from "@shared/events/AppEvents";
import type { EventQuery } from "./EventQuery";

/** Serialized payloads above this size are replaced by `{ truncated: true }`. */
export const MAX_PAYLOAD_BYTES = 4096;
const ERROR_LOG_INTERVAL_MS = 60_000;

export interface EventInput {
  type: string;
  source: string;
  entityId?: string | null;
  level?: string | null;
  payload?: Record<string, unknown>;
  clientId?: string | null;
  clientName?: string | null;
}

/** API shape of one stored event (`id` is the bigint as a string). */
export interface EventView {
  id: string;
  ts: string;
  type: string;
  source: string;
  entityId: string | null;
  level: string | null;
  clientId: string | null;
  clientName: string | null;
  payload: Record<string, unknown>;
}

/** Returns the payload, or `{ truncated: true }` when its JSON form is over MAX_PAYLOAD_BYTES. */
export function capPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES ? { truncated: true } : payload;
}

/**
 * Append-only event log over the `events` table. `record` is fire-and-forget:
 * it never throws and never makes the caller wait. After a successful insert it
 * publishes `{ type: "event", event }` on the change bus (SSE `event`).
 */
export class EventLog {
  private lastErrorLogAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly db: Queryable = pool) {}

  /** Records an event without awaiting it. Failures are logged (at most once a minute) and dropped. */
  record(input: EventInput): void {
    this.insert(input).then(
      (event) => {
        try {
          appEvents.emit({ type: "event", event });
        } catch (err) {
          this.logFailure(err);
        }
      },
      (err: unknown) => this.logFailure(err)
    );
  }

  /** Inserts one event and resolves with its stored API shape. Rejects on a db error. */
  async insert(input: EventInput): Promise<EventView> {
    const payload = capPayload(input.payload ?? {});
    const entityId = input.entityId ?? null;
    const level = input.level ?? null;
    const clientId = input.clientId ?? null;
    const clientName = input.clientName ?? null;
    const { rows } = await this.db.query(
      "INSERT INTO events (type, source, client_id, client_name, entity_id, level, payload) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, ts",
      [input.type, input.source, clientId, clientName, entityId, level, JSON.stringify(payload)]
    );
    return {
      id: String(rows[0].id),
      ts: new Date(rows[0].ts).toISOString(),
      type: input.type,
      source: input.source,
      entityId,
      level,
      clientId,
      clientName,
      payload,
    };
  }

  /** Newest first (`ORDER BY id DESC`). Every filter is a bound parameter. */
  async list(query: EventQuery): Promise<EventView[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (query.types) clauses.push(`type = ANY(${bind(query.types)}::text[])`);
    if (query.entityId) clauses.push(`entity_id = ${bind(query.entityId)}`);
    if (query.from) clauses.push(`ts >= ${bind(query.from)}::timestamptz`);
    if (query.to) clauses.push(`ts <= ${bind(query.to)}::timestamptz`);
    if (query.before) clauses.push(`id < ${bind(query.before)}::bigint`);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.db.query(
      `SELECT id, ts, type, source, entity_id, level, client_id, client_name, payload FROM events ${where} ORDER BY id DESC LIMIT ${bind(query.limit)}`,
      params
    );
    return rows.map((row) => ({
      id: String(row.id),
      ts: new Date(row.ts).toISOString(),
      type: row.type,
      source: row.source,
      entityId: row.entity_id ?? null,
      level: row.level ?? null,
      clientId: row.client_id ?? null,
      clientName: row.client_name ?? null,
      payload: row.payload ?? {},
    }));
  }

  private logFailure(err: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogAt = now;
    Logger.error(`event not recorded: ${(err as Error)?.message ?? String(err)}`, "EVENTS");
  }
}

export const eventLog = new EventLog();

/** Records a `config_changed` event for every `resource_changed` on the bus. Returns the unsubscribe function. */
export function startConfigChangedRecorder(log: EventLog = eventLog): () => void {
  return appEvents.subscribe((evt) => {
    if (evt.type !== "resource_changed") return;
    log.record({
      type: "config_changed",
      source: "api",
      clientId: evt.by,
      payload: { resource: evt.resource, keys: evt.keys },
    });
  });
}
