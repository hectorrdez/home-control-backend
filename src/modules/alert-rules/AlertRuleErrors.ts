import ApiError from "@errors/ApiError";

/** Body is not an object, a field is missing or invalid, or the trigger/level/message fails validation. */
export class InvalidRuleError extends ApiError {
  constructor(msg: string = "Invalid alert rule: check trigger, level and message") {
    super(msg, 400, "invalid_rule");
  }
}

/** Creating one more rule would exceed the store limit. */
export class TooManyRulesError extends ApiError {
  constructor(msg: string = "At most 500 alert rules can be stored") {
    super(msg, 400, "too_many_rules");
  }
}

/** Another rule already exists for the same entity and trigger (type plus value). */
export class DuplicateRuleError extends ApiError {
  constructor(msg: string = "A rule with this trigger already exists for this entity") {
    super(msg, 409, "duplicate_rule");
  }
}

/** PUT target id is not in the store. */
export class RuleNotFoundError extends ApiError {
  constructor(msg: string = "Alert rule not found") {
    super(msg, 404, "rule_not_found");
  }
}

/** The atomic write to the alert rules file failed; memory is left unchanged. */
export class AlertRulesWriteFailedError extends ApiError {
  constructor(msg: string = "Could not save the alert rule") {
    super(msg, 500, "alert_rules_write_failed");
  }
}
