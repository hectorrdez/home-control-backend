import ApiError from "@errors/ApiError";

/** `openMs` / `closeMs` missing, not integers, or outside 500..300000. */
export class InvalidCalibrationError extends ApiError {
  constructor(msg: string = "openMs and closeMs must be integers between 500 and 300000") {
    super(msg, 400, "invalid_calibration");
  }
}

/** Creating one more calibration would exceed the store limit. */
export class TooManyCalibrationsError extends ApiError {
  constructor(msg: string = "At most 200 covers can be calibrated") {
    super(msg, 400, "too_many_calibrations");
  }
}

/** The atomic write to the calibrations file failed; memory is left unchanged. */
export class CalibrationWriteFailedError extends ApiError {
  constructor(msg: string = "Could not save the calibration") {
    super(msg, 500, "calibrations_write_failed");
  }
}
