import {
  fetchAreaIndex,
  fetchDeviceNameIndex,
  fetchStates,
  normalizeEntity,
  NormalizedEntity,
} from "@modules/ha/HaStates";

export interface EntityFilter {
  domain?: string;
  area?: string;
}

/** Lists entities from HA states, filtered by domain and/or area id. Unknown filters yield []. */
export async function listEntities(filter: EntityFilter): Promise<NormalizedEntity[]> {
  const [states, areas, devices] = await Promise.all([fetchStates(), fetchAreaIndex(), fetchDeviceNameIndex()]);
  return states
    .map((s) => normalizeEntity(s, areas, devices))
    .filter((e) => !filter.domain || e.domain === filter.domain)
    .filter((e) => !filter.area || e.area === filter.area)
    .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
}
