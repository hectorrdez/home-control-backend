import ApiError from "@errors/ApiError";

/** `entityIds` absent or empty after trimming. */
export class MissingEntityIdsError extends ApiError {
  constructor(msg: string = "entityIds is required") {
    super(msg, 400, "missing_entity_ids");
  }
}

/** More than 20 distinct entity ids requested. */
export class TooManyEntitiesError extends ApiError {
  constructor(msg: string = "At most 20 entities per request") {
    super(msg, 400, "too_many_entities");
  }
}

/** `hours` is not an integer in 1..720. */
export class InvalidHoursError extends ApiError {
  constructor(msg: string = "hours must be an integer between 1 and 720") {
    super(msg, 400, "invalid_hours");
  }
}
