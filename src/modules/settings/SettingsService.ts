import settingStore, { SettingEntry, SettingView } from "./SettingStore";
import { SettingNotFoundError, TooManySettingsError, VersionConflictError } from "./SettingErrors";
import { MAX_SETTINGS, parseSettingBody, parseSettingKey } from "./SettingValidation";

const toView = (key: string, entry: SettingEntry): SettingView => ({ key, ...entry });

/** All settings sorted by key. `[]` when empty. */
export function listSettings(): SettingView[] {
  return settingStore.list();
}

/** One setting by key. Unknown key -> setting_not_found. */
export function getSetting(rawKey: string): SettingView[] {
  const key = parseSettingKey(rawKey);
  const entry = settingStore.get(key);
  if (!entry) throw new SettingNotFoundError();
  return [toView(key, entry)];
}

/**
 * Creates or replaces a setting. Returns the stored setting. A write happens
 * only when the value actually changes; `baseVersion` (optional) makes the write
 * conditional on the current version.
 */
export async function putSetting(rawKey: string, rawBody: unknown, by: string | null = null): Promise<SettingView[]> {
  const key = parseSettingKey(rawKey);
  const { value, baseVersion, json } = parseSettingBody(rawBody);
  let stored!: SettingEntry;
  await settingStore.mutate((draft, { now }) => {
    const current = draft.get(key);
    if (baseVersion !== undefined && baseVersion !== current?.version) throw new VersionConflictError(current);
    if (current) {
      if (JSON.stringify(current.value) === json) {
        stored = current;
        return false;
      }
      stored = { value, version: current.version + 1, updatedAt: now, updatedBy: by };
    } else {
      if (draft.size >= MAX_SETTINGS) throw new TooManySettingsError();
      stored = { value, version: 1, updatedAt: now, updatedBy: by };
    }
    draft.set(key, stored);
    return true;
  }, { by });
  return [toView(key, stored)];
}

/** Removes one setting. Idempotent. The contract response is always an empty array. */
export async function deleteSetting(rawKey: string, by: string | null = null): Promise<SettingView[]> {
  const key = parseSettingKey(rawKey);
  await settingStore.mutate((draft) => draft.delete(key), { by });
  return [];
}
