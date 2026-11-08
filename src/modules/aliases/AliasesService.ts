import aliasStore, { AliasEntry } from "./AliasStore";
import { TooManyAliasesError } from "./AliasErrors";
import { MAX_ALIASES, parseAlias, parseEntityId } from "./AliasValidation";

/** All stored aliases, sorted by entityId. */
export function listAliases(): AliasEntry[] {
  return aliasStore.list();
}

/** Creates or replaces the alias for one entity; returns the stored, normalized value. */
export async function setAlias(rawEntityId: string, rawAlias: unknown, by: string | null = null): Promise<AliasEntry[]> {
  const entityId = parseEntityId(rawEntityId);
  const alias = parseAlias(rawAlias);
  await aliasStore.mutate((draft) => {
    if (!draft.has(entityId) && draft.size >= MAX_ALIASES) throw new TooManyAliasesError();
    if (draft.get(entityId) === alias) return false;
    draft.set(entityId, alias);
    return true;
  }, { by });
  return [{ entityId, alias }];
}

/** Removes the alias for one entity. Idempotent. The contract response is always an empty array. */
export async function deleteAlias(rawEntityId: string, by: string | null = null): Promise<AliasEntry[]> {
  const entityId = parseEntityId(rawEntityId);
  await aliasStore.mutate((draft) => draft.delete(entityId), { by });
  return [];
}
