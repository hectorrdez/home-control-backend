import ApiError from "@errors/ApiError";

/** Any bad `GET /api/alerts` query parameter. The message names the parameter. */
export class InvalidAlertQueryError extends ApiError {
  constructor(msg: string = "Invalid query") {
    super(msg, 400, "invalid_query");
  }
}

/** Unknown or malformed alert id. */
export class AlertNotFoundError extends ApiError {
  constructor() {
    super("Alert not found", 404, "alert_not_found");
  }
}

/** Bad body of the non-production test-fire hook. */
export class InvalidAlertError extends ApiError {
  constructor(msg: string = "Invalid alert") {
    super(msg, 400, "invalid_alert");
  }
}
