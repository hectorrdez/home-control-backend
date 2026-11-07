import { InvalidEntityIdError } from "@modules/entities/EntityErrors";
import { InvalidRuleError } from "./AlertRuleErrors";

export const MAX_ALERT_RULES = 500;
export const ALERT_LEVELS = ["off", "low", "medium", "high"] as const;
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const MAX_STATE_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 120;

export type AlertLevel = (typeof ALERT_LEVELS)[number];

export type AlertTrigger =
  | { type: "connects" | "disconnects" | "interacted" }
  | { type: "state_becomes"; value: string }
  | { type: "above" | "below"; value: number };

/** Stored fields of a rule (the id is the store key). */
export interface AlertRuleFields {
  entityId: string;
  trigger: AlertTrigger;
  level: AlertLevel;
  message?: string;
}

const isObject = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === "object";

function readTrigger(raw: unknown): AlertTrigger | undefined {
  if (!isObject(raw)) return undefined;
  const type = raw.type;
  const value = raw.value;
  switch (type) {
    case "connects":
    case "disconnects":
    case "interacted":
      return { type };
    case "state_becomes":
      return typeof value === "string" && value.length >= 1 && value.length <= MAX_STATE_LENGTH
        ? { type, value }
        : undefined;
    case "above":
    case "below":
      return typeof value === "number" && Number.isFinite(value) ? { type, value } : undefined;
    default:
      return undefined;
  }
}

/**
 * Full validation of one rule's fields (entity id shape, trigger, level, optional message).
 * Returns undefined when anything is invalid; never throws. Used by the body parser and the file load.
 */
export function readRuleFields(raw: unknown): AlertRuleFields | undefined {
  if (!isObject(raw)) return undefined;
  const entityId = raw.entityId;
  if (typeof entityId !== "string" || !ENTITY_ID_RE.test(entityId)) return undefined;
  const trigger = readTrigger(raw.trigger);
  if (!trigger) return undefined;
  const level = raw.level;
  if (!(ALERT_LEVELS as readonly unknown[]).includes(level)) return undefined;
  const message = raw.message;
  if (message === undefined) return { entityId, trigger, level: level as AlertLevel };
  if (typeof message !== "string" || message.length < 1 || message.length > MAX_MESSAGE_LENGTH) return undefined;
  return { entityId, trigger, level: level as AlertLevel, message };
}

/** Request body check. Bad entity id -> invalid_entity_id (400); anything else -> invalid_rule (400). */
export function parseRuleBody(raw: unknown): AlertRuleFields {
  if (!isObject(raw)) throw new InvalidRuleError();
  const entityId = raw.entityId;
  if (typeof entityId !== "string" || !ENTITY_ID_RE.test(entityId)) {
    throw new InvalidEntityIdError(`invalid entity id: ${String(entityId)}`);
  }
  const fields = readRuleFields(raw);
  if (!fields) throw new InvalidRuleError();
  return fields;
}

/** Entity id query filter (GET ?entityId=). */
export function parseEntityIdFilter(raw: string): string {
  if (!ENTITY_ID_RE.test(raw)) throw new InvalidEntityIdError(`invalid entity id: ${raw}`);
  return raw;
}

/** Identity used for the one-rule-per-trigger rule: entity plus trigger type plus value. */
export function triggerKey(fields: AlertRuleFields): string {
  const { trigger } = fields;
  return JSON.stringify([fields.entityId, trigger.type, "value" in trigger ? trigger.value : null]);
}
