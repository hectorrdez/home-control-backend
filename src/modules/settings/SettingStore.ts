import { MutateContext, PgDocumentStore } from "../../shared/PgDocumentStore";
import type { TxSource } from "../../db/pool";
import { appEvents } from "../../shared/events/AppEvents";
import { SettingsWriteFailedError } from "./SettingErrors";
import { isValidSettingKey, isValidStoredEntry, MAX_SETTINGS } from "./SettingValidation";

/** Stored document value. The same fields are mirrored in the row columns by PgDocumentStore. */
export interface SettingEntry {
  value: unknown;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SettingView extends SettingEntry {
  key: string;
}

/** Postgres document store for shared app settings (see PgDocumentStore for load / serialized write mechanics). */
export class SettingStore {
  private store: PgDocumentStore<SettingEntry>;

  constructor(db?: TxSource) {
    this.store = new PgDocumentStore<SettingEntry>({
      db,
      scope: "SettingStore",
      collection: "settings",
      legacyProperty: "settings",
      entryLabel: "setting",
      max: MAX_SETTINGS,
      parseEntry: (key, raw) => (isValidSettingKey(key) && isValidStoredEntry(raw) ? (raw as SettingEntry) : undefined),
      createWriteError: () => new SettingsWriteFailedError(),
      onChanged: (keys, by) => appEvents.emit({ type: "resource_changed", resource: "settings", keys, by }),
    });
  }

  /** Reads the collection from the database. Throws on a db error (startup fails). */
  load(): Promise<void> {
    return this.store.load();
  }

  /** All settings sorted by key. */
  list(): SettingView[] {
    return this.store.entries().map(([key, entry]) => ({ key, ...entry }));
  }

  get(key: string): SettingEntry | undefined {
    return this.store.get(key);
  }

  /** `change` returns false when nothing changed (no write). Throws its error or SettingsWriteFailedError. */
  mutate(
    change: (draft: Map<string, SettingEntry>, ctx: MutateContext) => boolean,
    opts: { by?: string | null } = {}
  ): Promise<void> {
    return this.store.mutate(change, opts);
  }
}

const settingStore = new SettingStore();
export default settingStore;
