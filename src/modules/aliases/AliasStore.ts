import { PgDocumentStore, importLegacyJson } from "../../shared/PgDocumentStore";
import type { TxSource } from "../../db/pool";
import { appEvents } from "../../shared/events/AppEvents";
import { AliasWriteFailedError } from "./AliasErrors";
import { isValidAlias, isValidEntityId, MAX_ALIASES } from "./AliasValidation";

export interface AliasEntry {
  entityId: string;
  alias: string;
}

/**
 * Postgres document store for user entity aliases (see PgDocumentStore for the
 * load / transactional serialized write mechanics).
 */
export class AliasStore {
  private store: PgDocumentStore<string>;

  constructor(db?: TxSource) {
    this.store = new PgDocumentStore<string>({
      db,
      scope: "AliasStore",
      collection: "aliases",
      legacyProperty: "aliases",
      entryLabel: "alias",
      max: MAX_ALIASES,
      parseEntry: (entityId, raw) => (isValidEntityId(entityId) && typeof raw === "string" && isValidAlias(raw) ? raw : undefined),
      createWriteError: () => new AliasWriteFailedError(),
      onChanged: (keys, by) => appEvents.emit({ type: "resource_changed", resource: "aliases", keys, by }),
    });
  }

  /** Reads the collection from the database. Throws on a db error (startup fails). */
  load(): Promise<void> {
    return this.store.load();
  }

  /** One-time import of the legacy JSON file (see importLegacyJson). */
  importLegacy(file: string): Promise<void> {
    return importLegacyJson(this.store, file);
  }

  list(): AliasEntry[] {
    return this.store.entries().map(([entityId, alias]) => ({ entityId, alias }));
  }

  get(entityId: string): string | undefined {
    return this.store.get(entityId);
  }

  /** `change` returns false when nothing changed (no write). Throws its error or AliasWriteFailedError. */
  mutate(change: (draft: Map<string, string>) => boolean, opts: { by?: string | null } = {}): Promise<void> {
    return this.store.mutate(change, opts);
  }
}

const aliasStore = new AliasStore();
export default aliasStore;
