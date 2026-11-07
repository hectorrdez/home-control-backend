import { randomUUID } from "crypto";
import alertRuleStore, { AlertRule } from "./AlertRuleStore";
import { DuplicateRuleError, RuleNotFoundError, TooManyRulesError } from "./AlertRuleErrors";
import { AlertRuleFields, MAX_ALERT_RULES, parseEntityIdFilter, parseRuleBody, triggerKey } from "./AlertRuleValidation";

/** Throws DuplicateRuleError when another rule (not `selfId`) has the same entity and trigger identity. */
function assertNoDuplicate(draft: Map<string, AlertRuleFields>, fields: AlertRuleFields, selfId: string): void {
  const key = triggerKey(fields);
  for (const [id, other] of draft) {
    if (id !== selfId && triggerKey(other) === key) throw new DuplicateRuleError();
  }
}

/** All stored rules, optionally filtered by entityId. Sorted by entityId then id. */
export function listAlertRules(rawEntityId?: string): AlertRule[] {
  const entityId = rawEntityId === undefined ? undefined : parseEntityIdFilter(rawEntityId);
  return alertRuleStore.list().filter((rule) => entityId === undefined || rule.entityId === entityId);
}

/** Creates a rule with a server-generated id. Returns the created rule. */
export async function createAlertRule(rawBody: unknown): Promise<AlertRule[]> {
  const fields = parseRuleBody(rawBody);
  const id = randomUUID();
  await alertRuleStore.mutate((draft) => {
    if (draft.size >= MAX_ALERT_RULES) throw new TooManyRulesError();
    assertNoDuplicate(draft, fields, id);
    draft.set(id, fields);
    return true;
  });
  return [{ id, ...fields }];
}

/** Replaces the rule with this id (the id is immutable). Returns the stored rule. */
export async function replaceAlertRule(id: string, rawBody: unknown): Promise<AlertRule[]> {
  const fields = parseRuleBody(rawBody);
  await alertRuleStore.mutate((draft) => {
    if (!draft.has(id)) throw new RuleNotFoundError();
    assertNoDuplicate(draft, fields, id);
    draft.set(id, fields);
    return true;
  });
  return [{ id, ...fields }];
}

/** Removes one rule. Idempotent. The contract response is always an empty array. */
export async function deleteAlertRule(id: string): Promise<AlertRule[]> {
  await alertRuleStore.mutate((draft) => draft.delete(id));
  return [];
}
