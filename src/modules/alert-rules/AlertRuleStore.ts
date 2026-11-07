import { JsonFileStore } from "../../shared/JsonFileStore";
import { AlertRulesWriteFailedError } from "./AlertRuleErrors";
import { AlertRuleFields, MAX_ALERT_RULES, readRuleFields } from "./AlertRuleValidation";

export interface AlertRule extends AlertRuleFields {
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * JSON file store for alert rules, keyed by rule id (see JsonFileStore for the
 * load / atomic serialized write / quarantine mechanics).
 */
export class AlertRuleStore {
  private store = new JsonFileStore<AlertRuleFields>({
    scope: "AlertRuleStore",
    property: "rules",
    entryLabel: "alert rule",
    max: MAX_ALERT_RULES,
    parseEntry: (id, raw) => (UUID_RE.test(id) ? readRuleFields(raw) : undefined),
    createWriteError: () => new AlertRulesWriteFailedError(),
  });

  /** Loads the file synchronously at startup. Never throws. */
  load(file: string): void {
    this.store.load(file);
  }

  /** All rules sorted by entityId, then id. */
  list(): AlertRule[] {
    return this.store
      .entries()
      .map(([id, fields]) => ({ id, ...fields }))
      .sort((a, b) => cmp(a.entityId, b.entityId) || cmp(a.id, b.id));
  }

  get(id: string): AlertRuleFields | undefined {
    return this.store.get(id);
  }

  /** `change` returns false when nothing changed (no write). Throws its error or AlertRulesWriteFailedError. */
  mutate(change: (draft: Map<string, AlertRuleFields>) => boolean): Promise<void> {
    return this.store.mutate(change);
  }
}

const alertRuleStore = new AlertRuleStore();
export default alertRuleStore;
