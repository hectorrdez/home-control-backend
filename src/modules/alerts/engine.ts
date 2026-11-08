import type { AlertRule } from "@modules/alert-rules/AlertRuleStore";
import type { AlertLevel, AlertTrigger } from "@modules/alert-rules/AlertRuleValidation";

// Pure alert evaluation, ported from the frontend (features/alerts/engine.ts, rules.ts, state/availability.ts).
// No I/O. Level "off" never fires. Keep the behaviour in step with the frontend copy.

/** Shape the engine needs from an entity (the hub's NormalizedEntity satisfies it). */
export interface EntityLike {
  entityId: string;
  domain: string;
  state: string;
  attributes: Record<string, unknown>;
  lastChanged: string;
}

export type FiringLevel = Exclude<AlertLevel, "off">;

export interface AlertEvent {
  rule: AlertRule;
  entityId: string;
  level: FiringLevel;
  /** The rule message, or the trigger label. */
  text: string;
  /** lastChanged of the entity that fired. */
  at: string;
}

export interface EvalContext {
  interacted: boolean;
}

/** One rule per entity and event: the same rule does not fire again within this window. */
export const DEDUPE_MS = 2000;

// Domains whose state may legitimately be "unknown" (assumed-state covers, scenes and scripts never report a state).
const UNKNOWN_STATE_DOMAINS = new Set(["cover", "scene", "script"]);

/** "unavailable" (and "unknown" outside UNKNOWN_STATE_DOMAINS) means the entity has no live link. */
export function isUnavailable(entity: EntityLike): boolean {
  if (entity.state === "unavailable") return true;
  return entity.state === "unknown" && !UNKNOWN_STATE_DOMAINS.has(entity.domain);
}

function numeric(entity: EntityLike): number | null {
  if (entity.state.trim() === "") return null;
  const n = Number(entity.state);
  return Number.isFinite(n) ? n : null;
}

/** Whether a change from `before` to `after` alters anything the rules look at (state, lastChanged or attributes). */
export function differs(a: EntityLike, b: EntityLike): boolean {
  return a.state !== b.state || a.lastChanged !== b.lastChanged || JSON.stringify(a.attributes) !== JSON.stringify(b.attributes);
}

// A trigger fires on the change from `before` to `after`. above/below fire only on a crossing, so a rule re-arms.
export function fires(trigger: AlertTrigger, before: EntityLike, after: EntityLike, ctx: EvalContext): boolean {
  switch (trigger.type) {
    case "connects":
      return isUnavailable(before) && !isUnavailable(after);
    case "disconnects":
      return !isUnavailable(before) && isUnavailable(after);
    case "interacted":
      return ctx.interacted;
    case "state_becomes":
      return after.state === trigger.value && before.state !== trigger.value;
    case "above":
    case "below": {
      const a = numeric(before);
      const b = numeric(after);
      if (a === null || b === null) return false;
      return trigger.type === "above" ? a <= trigger.value && b > trigger.value : a >= trigger.value && b < trigger.value;
    }
  }
}

/** Unit of measurement from the entity attributes, when it is a string. */
export function unitOf(entity: EntityLike): string | undefined {
  return typeof entity.attributes.unit_of_measurement === "string" ? entity.attributes.unit_of_measurement : undefined;
}

/** Human label of a trigger (the default alert text). */
export function triggerLabel(trigger: AlertTrigger, unit?: string): string {
  switch (trigger.type) {
    case "connects":
      return "CONNECTS";
    case "disconnects":
      return "DISCONNECTS";
    case "interacted":
      return "USER INTERACTS";
    case "state_becomes":
      return `BECOMES ${trigger.value.toUpperCase()}`;
    case "above":
    case "below":
      return `${trigger.type.toUpperCase()} ${trigger.value}${unit ? ` ${unit}` : ""}`;
  }
}

/** The alerts one change raises: enabled rules of this entity whose trigger fires. */
export function evaluate(rules: readonly AlertRule[], before: EntityLike, after: EntityLike, ctx: EvalContext): AlertEvent[] {
  return rules.flatMap((rule) => {
    if (rule.entityId !== after.entityId || rule.level === "off" || !fires(rule.trigger, before, after, ctx)) return [];
    return [
      {
        rule,
        entityId: after.entityId,
        level: rule.level,
        text: rule.message ?? triggerLabel(rule.trigger, unitOf(after)),
        at: after.lastChanged,
      },
    ];
  });
}

/** Keeps the firings that are not repeats of the same rule within DEDUPE_MS, and records their time. */
export function takeFirings(events: AlertEvent[], lastFired: Map<string, number>, now: number): AlertEvent[] {
  return events.filter((event) => {
    const last = lastFired.get(event.rule.id);
    if (last !== undefined && now - last < DEDUPE_MS) return false;
    lastFired.set(event.rule.id, now);
    return true;
  });
}
