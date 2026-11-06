import ApiError from "@errors/ApiError";

/** HA_URL or HA_TOKEN not set. */
export class HaNotConfiguredError extends ApiError {
  constructor(msg: string = "Home Assistant is not configured") {
    super(msg, 503, "ha_not_configured");
  }
}

/** HA did not answer (network down, timeout, wrong host). */
export class HaUnreachableError extends ApiError {
  constructor(msg: string = "Home Assistant unreachable") {
    super(msg, 503, "ha_unreachable");
  }
}

/** HA rejected HA_TOKEN (401/403). Server-side misconfiguration, so 502. */
export class HaUnauthorizedError extends ApiError {
  constructor(msg: string = "Home Assistant rejected the access token") {
    super(msg, 502, "ha_unauthorized");
  }
}

/** HA answered, but not with what we expected. */
export class HaUnexpectedResponseError extends ApiError {
  constructor(msg: string = "Unexpected response from Home Assistant") {
    super(msg, 502, "ha_unexpected_response");
  }
}
