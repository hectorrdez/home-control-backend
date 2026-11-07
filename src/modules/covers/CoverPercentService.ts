import calibrationStore from "@modules/calibrations/CalibrationStore";
import { parseEntityId } from "@modules/calibrations/CalibrationValidation";
import { EntityNotFoundError, InvalidParamsError } from "@modules/entities/EntityErrors";
import { fetchState, normalizeLive, NormalizedEntity } from "@modules/ha/HaStates";
import coverMoves, { requireCalibration } from "./CoverMoves";

/** Validates `{ percent }` (integer 0..100, 100 = fully open). */
export function parsePercent(raw: unknown): number {
  const body = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const percent = body.percent;
  if (!Number.isInteger(percent) || (percent as number) < 0 || (percent as number) > 100) {
    throw new InvalidParamsError("percent must be an integer between 0 and 100");
  }
  return percent as number;
}

/**
 * Starts a timed move to `percent` for a calibrated cover and returns its normalized state.
 * Order: id/domain (400/403), percent (400), calibration (409, no HA call), entity (404), move.
 */
export async function setCoverPercent(rawEntityId: string, rawBody: unknown): Promise<NormalizedEntity[]> {
  const entityId = parseEntityId(rawEntityId);
  const percent = parsePercent(rawBody);
  requireCalibration(calibrationStore, entityId);
  const state = await fetchState(entityId);
  if (!state) throw new EntityNotFoundError();

  await coverMoves.moveTo(entityId, percent);
  return [await normalizeLive((await fetchState(entityId)) ?? state)];
}
