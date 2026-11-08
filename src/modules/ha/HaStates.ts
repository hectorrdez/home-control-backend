import Logger from "@utils/Logger";
import { haGet, haGetOptional, haPostText } from "./HaClient";
import coverMoves from "@modules/covers/CoverMoves";
import { haCache } from "./HaCache";

/** Raw Home Assistant state object (only the fields we read). */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated?: string;
}

/** Normalized entity shape exposed to clients. */
export interface NormalizedEntity {
  entityId: string;
  domain: string;
  name: string;
  state: string;
  attributes: Record<string, unknown>;
  area: string | null;
  areaName: string | null;
  /** HA device name (name_by_user, else name); null when there is no device or it is unknown. */
  deviceName: string | null;
  lastChanged: string;
}

export interface AreaRef {
  areaId: string;
  areaName: string;
}

/** Attributes safe to expose: no HA internals, no context, no secrets. */
const SAFE_ATTRIBUTES = [
  "friendly_name",
  "device_class",
  "unit_of_measurement",
  "brightness",
  "color_temp",
  "hs_color",
  "rgb_color",
  "temperature",
  "current_temperature",
  "hvac_mode",
  "hvac_action",
  "percentage",
  "current_position",
  "position",
  "volume_level",
  "is_volume_muted",
  "media_title",
  "media_artist",
] as const;

const AREA_CACHE_MS = 30_000;
let areaCache: { at: number; byEntity: Map<string, AreaRef> } | null = null;

/** Full state list: from the WebSocket cache when ready, else REST. */
export async function fetchStates(): Promise<HaState[]> {
  if (haCache.isReady()) return haCache.allStates();
  return haGet<HaState[]>("/api/states");
}

/**
 * entity_id -> area, resolved with HA's template API (areas() / area_entities()).
 * Cached briefly so a list call does not hit HA twice.
 */
export async function fetchAreaIndex(): Promise<Map<string, AreaRef>> {
  if (haCache.isReady()) return haCache.areas();
  if (areaCache && Date.now() - areaCache.at < AREA_CACHE_MS) return areaCache.byEntity;

  const template =
    "{% for area in areas() %}{% for e in area_entities(area) %}" +
    "{{ e }}|{{ area }}|{{ area_name(area) }}\n" +
    "{% endfor %}{% endfor %}";
  const text = await haPostText("/api/template", { template });

  const byEntity = new Map<string, AreaRef>();
  for (const line of text.split("\n")) {
    const [entityId, areaId, areaName] = line.trim().split("|");
    if (entityId && areaId) byEntity.set(entityId, { areaId, areaName: areaName || areaId });
  }
  areaCache = { at: Date.now(), byEntity };
  return byEntity;
}

const AREA_LIST_TEMPLATE = "{% for area in areas() %}{{ area }}|{{ area_name(area) }}\n{% endfor %}";
let areaListCache: { at: number; areas: AreaRef[] } | null = null;

/** Every area defined in HA, including areas with no entities. Cached like fetchAreaIndex. */
export async function fetchAreaList(): Promise<AreaRef[]> {
  if (haCache.isReady()) return haCache.areaEntries();
  if (areaListCache && Date.now() - areaListCache.at < AREA_CACHE_MS) return areaListCache.areas;

  const text = await haPostText("/api/template", { template: AREA_LIST_TEMPLATE });
  const areas: AreaRef[] = [];
  for (const line of text.split("\n")) {
    const [areaId, areaName] = line.trim().split("|");
    if (areaId) areas.push({ areaId, areaName: areaName || areaId });
  }
  areaListCache = { at: Date.now(), areas };
  return areas;
}

const DEVICE_CACHE_MS = 60_000;
/** A failed lookup is retried sooner than a successful one is refreshed. */
const DEVICE_FAIL_CACHE_MS = 10_000;
let deviceCache: { at: number; ttl: number; byEntity: Map<string, string> } | null = null;
let deviceInflight: Promise<Map<string, string>> | null = null;

const DEVICE_NAME_TEMPLATE =
  "{% for s in states %}{{ s.entity_id }}|" +
  "{{ device_attr(s.entity_id, 'name_by_user') or device_attr(s.entity_id, 'name') or '' }}\n" +
  "{% endfor %}";

/** Parses `entity_id|device name` lines. Splits on the first `|` only; names may contain `|`. */
export function parseDeviceNames(text: string): Map<string, string> {
  const byEntity = new Map<string, string>();
  for (const line of text.split("\n")) {
    const cut = line.indexOf("|");
    if (cut < 0) continue;
    const entityId = line.slice(0, cut).trim();
    const name = line.slice(cut + 1).trim();
    if (entityId.includes(".") && name) byEntity.set(entityId, name);
  }
  return byEntity;
}

/**
 * entity_id -> HA device name, resolved with ONE batched template call per cache window.
 * Concurrent callers during a refresh share the same in-flight request.
 * Never rejects: any failure logs a warning and yields an empty map (every deviceName = null).
 */
export async function fetchDeviceNameIndex(): Promise<Map<string, string>> {
  if (haCache.isReady()) return haCache.devices();
  if (deviceCache && Date.now() - deviceCache.at < deviceCache.ttl) return deviceCache.byEntity;
  if (deviceInflight) return deviceInflight;

  deviceInflight = (async () => {
    try {
      const text = await haPostText("/api/template", { template: DEVICE_NAME_TEMPLATE });
      const byEntity = parseDeviceNames(text);
      deviceCache = { at: Date.now(), ttl: DEVICE_CACHE_MS, byEntity };
      return byEntity;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      Logger.write(`device names unavailable, deviceName=null: ${reason}`, "HaStates", "WARN");
      const empty = new Map<string, string>();
      deviceCache = { at: Date.now(), ttl: DEVICE_FAIL_CACHE_MS, byEntity: empty };
      return empty;
    } finally {
      deviceInflight = null;
    }
  })();
  return deviceInflight;
}

export function normalizeEntity(
  s: HaState,
  areas: Map<string, AreaRef>,
  deviceNames?: Map<string, string>
): NormalizedEntity {
  const domain = s.entity_id.split(".")[0];
  const attrs: Record<string, unknown> = {};
  for (const key of SAFE_ATTRIBUTES) {
    if (s.attributes && key in s.attributes) attrs[key] = s.attributes[key];
  }
  if (domain === "cover") attrs.estimated_position = coverMoves.estimatedPosition(s.entity_id);
  const area = areas.get(s.entity_id) ?? null;
  const friendly = typeof s.attributes?.friendly_name === "string" ? s.attributes.friendly_name : "";
  return {
    entityId: s.entity_id,
    domain,
    name: friendly || s.entity_id,
    state: s.state,
    attributes: attrs,
    area: area?.areaId ?? null,
    areaName: area?.areaName ?? null,
    deviceName: deviceNames?.get(s.entity_id) ?? null,
    lastChanged: s.last_changed,
  };
}

/** Normalizes one fresh state with the area and device indexes (cached). */
export async function normalizeLive(state: HaState): Promise<NormalizedEntity> {
  const [areas, devices] = await Promise.all([fetchAreaIndex(), fetchDeviceNameIndex()]);
  return normalizeEntity(state, areas, devices);
}

/** Single state lookup helper for control/action responses. */
export async function fetchState(entityId: string): Promise<HaState | null> {
  if (haCache.isReady()) return haCache.state(entityId);
  return haGetOptional<HaState>(`/api/states/${encodeURIComponent(entityId)}`);
}
