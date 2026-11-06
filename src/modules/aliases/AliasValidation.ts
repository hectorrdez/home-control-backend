import { InvalidAliasError, InvalidEntityIdError } from "./AliasErrors";

export const MAX_ALIASES = 2000;
const MAX_ALIAS_LENGTH = 80;
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
// After whitespace is collapsed, any remaining C0/C1 control character is rejected.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;

export function isValidEntityId(entityId: string): boolean {
  return ENTITY_ID_RE.test(entityId);
}

/** Trim, then collapse every whitespace run (tabs and newlines included) to one space. */
export function normalizeAlias(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Already-normalized alias: 1..80 code points, no control characters. */
export function isValidAlias(normalized: string): boolean {
  if (CONTROL_RE.test(normalized)) return false;
  const length = [...normalized].length;
  return length >= 1 && length <= MAX_ALIAS_LENGTH;
}

export function parseEntityId(raw: string): string {
  if (!isValidEntityId(raw)) throw new InvalidEntityIdError(`invalid entity id: ${raw}`);
  return raw;
}

/** Validates a request body `alias` field and returns the normalized value. */
export function parseAlias(raw: unknown): string {
  if (typeof raw !== "string") throw new InvalidAliasError();
  const normalized = normalizeAlias(raw);
  if (!isValidAlias(normalized)) throw new InvalidAliasError();
  return normalized;
}
