import ApiError from "@errors/ApiError";

/** `entityId` does not match `^[a-z_]+\.[a-z0-9_]+$`. */
export class InvalidEntityIdError extends ApiError {
  constructor(msg: string = "Invalid entity id") {
    super(msg, 400, "invalid_entity_id");
  }
}

/** Alias missing, not a string, empty after normalizing, too long, or has control characters. */
export class InvalidAliasError extends ApiError {
  constructor(msg: string = "alias must be 1-80 characters without control characters") {
    super(msg, 400, "invalid_alias");
  }
}

/** Creating one more alias would exceed the store limit. */
export class TooManyAliasesError extends ApiError {
  constructor(msg: string = "At most 2000 aliases can be stored") {
    super(msg, 400, "too_many_aliases");
  }
}

/** The atomic write to the aliases file failed; memory is left unchanged. */
export class AliasWriteFailedError extends ApiError {
  constructor(msg: string = "Could not save the alias") {
    super(msg, 500, "aliases_write_failed");
  }
}
