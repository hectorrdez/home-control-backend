import { PgDocumentStore } from "../../shared/PgDocumentStore";
import type { TxSource } from "../../db/pool";
import { appEvents } from "../../shared/events/AppEvents";
import { PresetsWriteFailedError } from "./PresetErrors";
import { MAX_PRESETS, PresetFields, readPresetFields } from "./PresetValidation";

export interface Preset extends PresetFields {
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Postgres document store for actuator presets (collection `presets`), keyed by preset id.
 * No legacy JSON file: the feature is new in 021.
 */
export class PresetStore {
  private store: PgDocumentStore<PresetFields>;

  constructor(db?: TxSource) {
    this.store = new PgDocumentStore<PresetFields>({
      db,
      scope: "PresetStore",
      collection: "presets",
      legacyProperty: "presets",
      entryLabel: "preset",
      max: MAX_PRESETS,
      parseEntry: (id, raw) => (UUID_RE.test(id) ? readPresetFields(raw) : undefined),
      createWriteError: () => new PresetsWriteFailedError(),
      onChanged: (keys, by) => appEvents.emit({ type: "resource_changed", resource: "presets", keys, by }),
    });
  }

  /** Reads the collection from the database. Throws on a db error (startup fails). */
  load(): Promise<void> {
    return this.store.load();
  }

  /** All presets sorted by entityId, then percent, then name. */
  list(): Preset[] {
    return this.store
      .entries()
      .map(([id, fields]) => ({ id, ...fields }))
      .sort((a, b) => cmp(a.entityId, b.entityId) || cmp(a.percent, b.percent) || cmp(a.name, b.name));
  }

  get(id: string): PresetFields | undefined {
    return this.store.get(id);
  }

  /** `change` returns false when nothing changed (no write). Throws its error or PresetsWriteFailedError. */
  mutate(
    change: (draft: Map<string, PresetFields>, ctx: { now: string }) => boolean,
    opts: { by?: string | null } = {}
  ): Promise<void> {
    return this.store.mutate(change, opts);
  }
}

const presetStore = new PresetStore();
export default presetStore;
