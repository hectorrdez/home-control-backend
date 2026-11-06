import { fetchAreaIndex, fetchAreaList, fetchStates, normalizeEntity, NormalizedEntity } from "@modules/ha/HaStates";

export interface AreaGroup {
  areaId: string | null;
  name: string;
  entities: NormalizedEntity[];
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "es", { sensitivity: "base" });

/**
 * Areas from HA (empty ones included), each with its entities sorted by name.
 * Entities without an area go to a final "Unassigned" group (always present).
 * Every entity from HA states appears exactly once.
 */
export async function listAreas(): Promise<AreaGroup[]> {
  const [states, areaList, index] = await Promise.all([fetchStates(), fetchAreaList(), fetchAreaIndex()]);

  const groups = new Map<string, AreaGroup>();
  for (const a of areaList) groups.set(a.areaId, { areaId: a.areaId, name: a.areaName, entities: [] });

  const unassigned: AreaGroup = { areaId: null, name: "Unassigned", entities: [] };
  for (const s of states) {
    const entity = normalizeEntity(s, index);
    if (entity.area === null) {
      unassigned.entities.push(entity);
      continue;
    }
    let group = groups.get(entity.area);
    if (!group) {
      group = { areaId: entity.area, name: entity.areaName ?? entity.area, entities: [] };
      groups.set(entity.area, group);
    }
    group.entities.push(entity);
  }

  const assigned = [...groups.values()].sort(byName);
  for (const g of [...assigned, unassigned]) g.entities.sort(byName);
  return [...assigned, unassigned];
}
