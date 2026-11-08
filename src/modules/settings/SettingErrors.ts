import ApiError from "@errors/ApiError";
import type { SettingEntry } from "./SettingStore";

/** Key does not match `^[a-z0-9]+(\.[a-z0-9_-]+){1,4}$` or is longer than 80 characters. */
export class InvalidSettingKeyError extends ApiError {
  constructor(msg: string = "Invalid setting key") {
    super(msg, 400, "invalid_setting_key");
  }
}

/** Body has no `value`, or `baseVersion` is present but not an integer >= 1. */
export class InvalidSettingError extends ApiError {
  constructor(msg: string = "Body must contain a value; baseVersion must be an integer >= 1") {
    super(msg, 400, "invalid_setting");
  }
}

/** Serialized value is larger than 65536 bytes. */
export class SettingTooLargeError extends ApiError {
  constructor(msg: string = "Setting value must be at most 65536 bytes") {
    super(msg, 413, "setting_too_large");
  }
}

/** GET of a key that does not exist. */
export class SettingNotFoundError extends ApiError {
  constructor(msg: string = "Setting not found") {
    super(msg, 404, "setting_not_found");
  }
}

/** Creating one more key would exceed the store limit. */
export class TooManySettingsError extends ApiError {
  constructor(msg: string = "At most 200 settings can be stored") {
    super(msg, 400, "too_many_settings");
  }
}

/** `baseVersion` does not match the stored version. Carries the current setting (undefined when the key is missing). */
export class VersionConflictError extends ApiError {
  constructor(readonly current: SettingEntry | undefined, msg: string = "Setting was changed by someone else") {
    super(msg, 409, "version_conflict");
  }
}

/** The atomic write failed; memory is left unchanged. */
export class SettingsWriteFailedError extends ApiError {
  constructor(msg: string = "Could not save the setting") {
    super(msg, 500, "settings_write_failed");
  }
}
