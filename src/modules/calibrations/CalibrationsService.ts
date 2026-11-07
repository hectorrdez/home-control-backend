import calibrationStore, { CalibrationEntry, CalibrationRecord } from "./CalibrationStore";
import { TooManyCalibrationsError } from "./CalibrationErrors";
import { MAX_CALIBRATIONS, parseCalibrationBody, parseEntityId } from "./CalibrationValidation";

/** All stored calibrations, sorted by entityId. */
export function listCalibrations(): CalibrationEntry[] {
  return calibrationStore.list();
}

/** Creates or replaces the calibration for one cover. Position is reset to null (unknown). */
export async function setCalibration(rawEntityId: string, rawBody: unknown): Promise<CalibrationEntry[]> {
  const entityId = parseEntityId(rawEntityId);
  const { openMs, closeMs } = parseCalibrationBody(rawBody);
  const record: CalibrationRecord = {
    openMs,
    closeMs,
    position: null,
    calibratedAt: new Date().toISOString(),
  };
  await calibrationStore.mutate((draft) => {
    if (!draft.has(entityId) && draft.size >= MAX_CALIBRATIONS) throw new TooManyCalibrationsError();
    draft.set(entityId, record);
    return true;
  });
  return [{ entityId, ...record }];
}

/** Removes the calibration for one cover. Idempotent. The contract response is always an empty array. */
export async function deleteCalibration(rawEntityId: string): Promise<CalibrationEntry[]> {
  const entityId = parseEntityId(rawEntityId);
  await calibrationStore.mutate((draft) => draft.delete(entityId));
  return [];
}
