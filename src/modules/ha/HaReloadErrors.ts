import ApiError from "@errors/ApiError";

/** HA_RELOAD_DOMAINS is set but empty: reloads are switched off. */
export class ReloadDisabledError extends ApiError {
  constructor(msg: string = "HA reload is disabled: HA_RELOAD_DOMAINS is empty") {
    super(msg, 400, "reload_disabled");
  }
}

/** Another reload is still running (one at a time). */
export class ReloadInProgressError extends ApiError {
  constructor(msg: string = "A reload is already in progress") {
    super(msg, 409, "reload_in_progress");
  }
}

/** The previous reload finished less than 30 s ago. */
export class ReloadCooldownError extends ApiError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, msg: string = "Wait before reloading again") {
    super(msg, 429, "reload_cooldown");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
