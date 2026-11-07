import { DomainNotAllowedError, InvalidEntityIdError } from "@modules/entities/EntityErrors";
import { InvalidCalibrationError } from "./CalibrationErrors";

export const MAX_CALIBRATIONS = 200;
export const COVER_DOMAIN = "cover";
const MIN_DURATION_MS = 500;
const MAX_DURATION_MS = 300000;
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

/** Shape check plus domain check (only `cover` entities can be calibrated). */
export function isValidEntityId(entityId: string): boolean {
  return ENTITY_ID_RE.test(entityId) && entityId.split(".")[0] === COVER_DOMAIN;
}

export function isValidDurationMs(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_DURATION_MS && (value as number) <= MAX_DURATION_MS;
}

/** Stored record check used on file load (position is null until a percent calibration exists). */
export function isValidCalibrationRecord(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  const position = r.position;
  const validPosition =
    position === null || (Number.isInteger(position) && (position as number) >= 0 && (position as number) <= 100);
  return (
    isValidDurationMs(r.openMs) &&
    isValidDurationMs(r.closeMs) &&
    validPosition &&
    typeof r.calibratedAt === "string" &&
    r.calibratedAt.length > 0
  );
}

/** Regex first (invalid_entity_id 400), then domain (domain_not_allowed 403). */
export function parseEntityId(raw: string): string {
  if (!ENTITY_ID_RE.test(raw)) throw new InvalidEntityIdError(`invalid entity id: ${raw}`);
  if (raw.split(".")[0] !== COVER_DOMAIN) throw new DomainNotAllowedError(`only cover entities can be calibrated: ${raw}`);
  return raw;
}

/** Validates the PUT body and returns the two durations. */
export function parseCalibrationBody(raw: unknown): { openMs: number; closeMs: number } {
  const body = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isValidDurationMs(body.openMs) || !isValidDurationMs(body.closeMs)) throw new InvalidCalibrationError();
  return { openMs: body.openMs, closeMs: body.closeMs };
}
