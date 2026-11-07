import { JsonFileStore } from "../../shared/JsonFileStore";
import { AliasWriteFailedError } from "./AliasErrors";
import { isValidAlias, isValidEntityId, MAX_ALIASES } from "./AliasValidation";

export interface AliasEntry {
  entityId: string;
  alias: string;
}

/**
 * JSON file store for user entity aliases (see JsonFileStore for the
 * load / atomic serialized write / quarantine mechanics).
 */
export class AliasStore {
  private store = new JsonFileStore<string>({
    scope: "AliasStore",
    property: "aliases",
    entryLabel: "alias",
    max: MAX_ALIASES,
    parseEntry: (entityId, raw) => (isValidEntityId(entityId) && typeof raw === "string" && isValidAlias(raw) ? raw : undefined),
    createWriteError: () => new AliasWriteFailedError(),
  });

  /** Loads the file synchronously at startup. Never throws. */
  load(file: string): void {
    this.store.load(file);
  }

  list(): AliasEntry[] {
    return this.store.entries().map(([entityId, alias]) => ({ entityId, alias }));
  }

  get(entityId: string): string | undefined {
    return this.store.get(entityId);
  }

  /** `change` returns false when nothing changed (no write). Throws its error or AliasWriteFailedError. */
  mutate(change: (draft: Map<string, string>) => boolean): Promise<void> {
    return this.store.mutate(change);
  }
}

const aliasStore = new AliasStore();
export default aliasStore;
