import { haGet } from "@modules/ha/HaClient";
import { HaState } from "@modules/ha/HaStates";
import { InvalidEntityIdError } from "@modules/entities/EntityErrors";
import { InvalidHoursError, MissingEntityIdsError, TooManyEntitiesError } from "./HistoryErrors";

export interface HistoryPoint {
  t: string;
  v: string;
}

export interface EntityHistory {
  entityId: string;
  points: HistoryPoint[];
}

const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const MAX_ENTITIES = 20;
const DEFAULT_HOURS = 24;
const MAX_HOURS = 720;

/** With minimal_response HA sends entity_id only on the first state of each series. */
type HistoryRow = HaState & { last_updated?: string };

/** Splits and validates `entityIds`: required, deduplicated, max 20, entity id regex. */
export function parseEntityIds(raw: string | undefined): string[] {
  const ids = [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new MissingEntityIdsError();
  if (ids.length > MAX_ENTITIES) throw new TooManyEntitiesError();
  for (const id of ids) {
    if (!ENTITY_ID_RE.test(id)) throw new InvalidEntityIdError(`invalid entity id: ${id}`);
  }
  return ids;
}

/** Integer 1..720; absent means the default of 24. */
export function parseHours(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HOURS;
  if (!/^\d+$/.test(raw)) throw new InvalidHoursError();
  const n = Number(raw);
  if (n < 1 || n > MAX_HOURS) throw new InvalidHoursError();
  return n;
}

function toIso(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/**
 * State history for each requested entity over the last `hours`, from HA's
 * recorder (`/api/history/period`). Entities without recorded history get
 * `points: []`; output follows the request order.
 */
export async function fetchHistory(ids: string[], hours: number, now: Date = new Date()): Promise<EntityHistory[]> {
  const start = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const query = [
    `filter_entity_id=${encodeURIComponent(ids.join(","))}`,
    `end_time=${encodeURIComponent(now.toISOString())}`,
    "minimal_response",
    "significant_changes_only",
  ].join("&");

  const series = await haGet<HistoryRow[][]>(`/api/history/period/${start}?${query}`);

  const byId = new Map<string, HistoryPoint[]>();
  for (const run of Array.isArray(series) ? series : []) {
    const entityId = run.find((row) => row.entity_id)?.entity_id;
    if (!entityId) continue;
    byId.set(
      entityId,
      run.map((row) => ({ t: toIso(row.last_changed ?? row.last_updated ?? ""), v: String(row.state) }))
    );
  }
  return ids.map((entityId) => ({ entityId, points: byId.get(entityId) ?? [] }));
}
