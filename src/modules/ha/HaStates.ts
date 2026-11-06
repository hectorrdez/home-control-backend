import { haGet, haPostText } from "./HaClient";

/** Raw Home Assistant state object (only the fields we read). */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
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

export async function fetchStates(): Promise<HaState[]> {
  return haGet<HaState[]>("/api/states");
}

/**
 * entity_id -> area, resolved with HA's template API (areas() / area_entities()).
 * Cached briefly so a list call does not hit HA twice.
 */
export async function fetchAreaIndex(): Promise<Map<string, AreaRef>> {
  if (areaCache && Date.now() - areaCache.at < AREA_CACHE_MS) return areaCache.byEntity;

  const template =
    "{% for area in areas() %}{% for e in area_entities(area) %}" +
    "{{ e }}|{{ area }}|{{ area_name(area) }}\n" +
    "{% endfor %}{% endfor %}";
  const text = await haPostText("/api/template", { template });

  const byEntity = new Map<string, AreaRef>();
  for (const line of text.split("\n")) {
    const [entityId, areaId, areaName] = line.trim().split("|");
    if (entityId && areaId) byEntity.set(entityId, { areaId, areaName: areaName ?? areaId });
  }
  areaCache = { at: Date.now(), byEntity };
  return byEntity;
}

export function normalizeEntity(s: HaState, areas: Map<string, AreaRef>): NormalizedEntity {
  const domain = s.entity_id.split(".")[0];
  const attrs: Record<string, unknown> = {};
  for (const key of SAFE_ATTRIBUTES) {
    if (s.attributes && key in s.attributes) attrs[key] = s.attributes[key];
  }
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
    lastChanged: s.last_changed,
  };
}

/** Single state lookup helper for control/action responses. */
export async function fetchState(entityId: string): Promise<HaState | null> {
  const all = await fetchStates();
  return all.find((s) => s.entity_id === entityId) ?? null;
}
