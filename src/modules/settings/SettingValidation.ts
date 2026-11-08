import { InvalidSettingError, InvalidSettingKeyError, SettingTooLargeError } from "./SettingErrors";

export const MAX_SETTINGS = 200;
export const MAX_SETTING_BYTES = 65536;
const MAX_KEY_LENGTH = 80;
const KEY_RE = /^[a-z0-9]+(\.[a-z0-9_-]+){1,4}$/;

export function isValidSettingKey(key: string): boolean {
  return key.length <= MAX_KEY_LENGTH && KEY_RE.test(key);
}

export function parseSettingKey(raw: string): string {
  if (!isValidSettingKey(raw)) throw new InvalidSettingKeyError(`invalid setting key: ${raw}`);
  return raw;
}

/**
 * Validates a PUT body. `value` may be any JSON value (except undefined). The
 * serialized size is checked here so the handler never writes an oversized value.
 */
export function parseSettingBody(raw: unknown): { value: unknown; baseVersion: number | undefined; json: string } {
  if (raw === null || typeof raw !== "object" || !("value" in raw)) throw new InvalidSettingError();
  const { value, baseVersion } = raw as { value: unknown; baseVersion?: unknown };
  if (value === undefined) throw new InvalidSettingError();
  if (baseVersion !== undefined && !(Number.isInteger(baseVersion) && (baseVersion as number) >= 1)) {
    throw new InvalidSettingError();
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_SETTING_BYTES) throw new SettingTooLargeError();
  return { value, baseVersion: baseVersion as number | undefined, json };
}

/** Stored entry check used on load: the value plus its bookkeeping fields. */
export function isValidStoredEntry(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return (
    "value" in r &&
    Number.isInteger(r.version) &&
    (r.version as number) >= 1 &&
    typeof r.updatedAt === "string" &&
    (r.updatedBy === null || typeof r.updatedBy === "string")
  );
}
