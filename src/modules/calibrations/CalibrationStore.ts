import { PgDocumentStore, importLegacyJson } from "../../shared/PgDocumentStore";
import type { TxSource } from "../../db/pool";
import { CalibrationWriteFailedError } from "./CalibrationErrors";
import { isValidCalibrationRecord, isValidEntityId, MAX_CALIBRATIONS } from "./CalibrationValidation";

export interface CalibrationRecord {
  openMs: number;
  closeMs: number;
  position: number | null;
  calibratedAt: string;
}

export interface CalibrationEntry extends CalibrationRecord {
  entityId: string;
}

/**
 * Postgres document store for cover calibrations (see PgDocumentStore for the
 * load / transactional serialized write mechanics).
 */
export class CalibrationStore {
  private store: PgDocumentStore<CalibrationRecord>;

  constructor(db?: TxSource) {
    this.store = new PgDocumentStore<CalibrationRecord>({
      db,
      scope: "CalibrationStore",
      collection: "calibrations",
      legacyProperty: "covers",
      entryLabel: "calibration",
      max: MAX_CALIBRATIONS,
      parseEntry: (entityId, raw) => {
        if (!isValidEntityId(entityId) || !isValidCalibrationRecord(raw)) return undefined;
        const r = raw as CalibrationRecord;
        return { openMs: r.openMs, closeMs: r.closeMs, position: r.position, calibratedAt: r.calibratedAt };
      },
      createWriteError: () => new CalibrationWriteFailedError(),
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

  list(): CalibrationEntry[] {
    return this.store.entries().map(([entityId, record]) => ({ entityId, ...record }));
  }

  get(entityId: string): CalibrationRecord | undefined {
    return this.store.get(entityId);
  }

  /** `change` returns false when nothing changed (no write). Throws its error or CalibrationWriteFailedError. */
  mutate(change: (draft: Map<string, CalibrationRecord>) => boolean): Promise<void> {
    return this.store.mutate(change);
  }
}

const calibrationStore = new CalibrationStore();
export default calibrationStore;
