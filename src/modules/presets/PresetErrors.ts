import ApiError from "@errors/ApiError";

/** Body is not an object, or entityId / name / percent (or a changed entityId on PUT) is invalid. */
export class InvalidPresetError extends ApiError {
  constructor(msg: string = "Invalid preset: check name and percent (integer 0..100)") {
    super(msg, 400, "invalid_preset");
  }
}

/** Creating one more preset would exceed the per-entity (10) or global (500) limit. */
export class TooManyPresetsError extends ApiError {
  constructor(msg: string = "At most 10 presets per entity and 500 in total can be stored") {
    super(msg, 400, "too_many_presets");
  }
}

/** Another preset of the same entity already has this name (case-insensitive, trimmed). */
export class DuplicatePresetError extends ApiError {
  constructor(msg: string = "A preset with this name already exists for this entity") {
    super(msg, 409, "duplicate_preset");
  }
}

/** PUT / apply target id is not in the store. */
export class PresetNotFoundError extends ApiError {
  constructor(msg: string = "Preset not found") {
    super(msg, 404, "preset_not_found");
  }
}

/** The cover has neither a calibration (010) nor a native position, so it cannot be driven to a percent. */
export class PresetNotApplicableError extends ApiError {
  constructor(msg: string = "Cover needs calibration or position feedback to apply a preset") {
    super(msg, 409, "preset_not_applicable");
  }
}

/** The atomic write to the presets collection failed; memory is left unchanged. */
export class PresetsWriteFailedError extends ApiError {
  constructor(msg: string = "Could not save the preset") {
    super(msg, 500, "presets_write_failed");
  }
}
