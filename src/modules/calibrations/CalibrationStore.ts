import { JsonFileStore } from "../../shared/JsonFileStore";
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
 * JSON file store for cover calibrations (see JsonFileStore for the
 * load / atomic serialized write / quarantine mechanics).
 */
export class CalibrationStore {
  private store = new JsonFileStore<CalibrationRecord>({
    scope: "CalibrationStore",
    property: "covers",
    entryLabel: "calibration",
    max: MAX_CALIBRATIONS,
    parseEntry: (entityId, raw) => {
      if (!isValidEntityId(entityId) || !isValidCalibrationRecord(raw)) return undefined;
      const r = raw as CalibrationRecord;
      return { openMs: r.openMs, closeMs: r.closeMs, position: r.position, calibratedAt: r.calibratedAt };
    },
    createWriteError: () => new CalibrationWriteFailedError(),
  });

  /** Loads the file synchronously at startup. Never throws. */
  load(file: string): void {
    this.store.load(file);
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
