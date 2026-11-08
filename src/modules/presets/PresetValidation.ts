import { DomainNotAllowedError, InvalidEntityIdError } from "@modules/entities/EntityErrors";
import { InvalidPresetError } from "./PresetErrors";

export const MAX_PRESETS = 500;
export const MAX_PRESETS_PER_ENTITY = 10;
export const PRESET_DOMAIN = "cover";
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const MAX_NAME_LENGTH = 30;

/** Stored fields of a preset (the id is the store key). */
export interface PresetFields {
  entityId: string;
  name: string;
  percent: number;
  createdAt: string;
}

const isObject = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === "object";

/** Trimmed name (1..30 chars, no control chars), or undefined. */
export function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name.length < 1 || name.length > MAX_NAME_LENGTH || CONTROL_CHARS_RE.test(name)) return undefined;
  return name;
}

/** Integer 0..100, or undefined. */
export function cleanPercent(raw: unknown): number | undefined {
  return Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= 100 ? (raw as number) : undefined;
}

/** Case-insensitive identity of a name within one entity. */
export const nameKey = (name: string): string => name.trim().toLowerCase();

/** Entity id query filter (GET ?entityId=): invalid_entity_id 400. */
export function parseEntityIdFilter(raw: string): string {
  if (!ENTITY_ID_RE.test(raw)) throw new InvalidEntityIdError(`invalid entity id: ${raw}`);
  return raw;
}

/** Path entity id of a body: regex (invalid_entity_id 400), then domain (domain_not_allowed 403). */
export function parseCoverEntityId(raw: unknown): string {
  if (typeof raw !== "string" || !ENTITY_ID_RE.test(raw)) {
    throw new InvalidEntityIdError(`invalid entity id: ${String(raw)}`);
  }
  if (raw.split(".")[0] !== PRESET_DOMAIN) throw new DomainNotAllowedError(`only cover entities take presets: ${raw}`);
  return raw;
}

/** Full validation of a stored value (used by the store on load). Never throws. */
export function readPresetFields(raw: unknown): PresetFields | undefined {
  if (!isObject(raw)) return undefined;
  const { entityId, name, percent, createdAt } = raw;
  if (typeof entityId !== "string" || !ENTITY_ID_RE.test(entityId) || entityId.split(".")[0] !== PRESET_DOMAIN) {
    return undefined;
  }
  const cleaned = cleanName(name);
  const pct = cleanPercent(percent);
  if (cleaned === undefined || pct === undefined || typeof createdAt !== "string") return undefined;
  return { entityId, name: cleaned, percent: pct, createdAt };
}

/** Request body for POST: entity id first (400/403), then name and percent (invalid_preset 400). */
export function parseCreateBody(raw: unknown): { entityId: string; name: string; percent: number } {
  const body = isObject(raw) ? raw : {};
  const entityId = parseCoverEntityId(body.entityId);
  const name = cleanName(body.name);
  const percent = cleanPercent(body.percent);
  if (name === undefined || percent === undefined) throw new InvalidPresetError();
  return { entityId, name, percent };
}

/** Request body for PUT: name and percent; entityId is optional but must match the stored one. */
export function parseUpdateBody(raw: unknown): { name: string; percent: number; entityId?: unknown } {
  if (!isObject(raw)) throw new InvalidPresetError();
  const name = cleanName(raw.name);
  const percent = cleanPercent(raw.percent);
  if (name === undefined || percent === undefined) throw new InvalidPresetError();
  return { name, percent, entityId: raw.entityId };
}
