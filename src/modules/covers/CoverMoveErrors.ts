import ApiError from "@errors/ApiError";

/** The cover has no calibration (010), so its travel time is unknown. */
export class NotCalibratedError extends ApiError {
  constructor(msg: string = "Cover is not calibrated") {
    super(msg, 409, "not_calibrated");
  }
}

/** An intermediate percent needs a known position; the client must move the cover to an end first. */
export class PositionUnknownError extends ApiError {
  constructor(msg: string = "Cover position is unknown; move it to 0 or 100 first") {
    super(msg, 409, "position_unknown");
  }
}
