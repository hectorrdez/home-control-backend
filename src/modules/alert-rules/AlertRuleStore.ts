import { PgDocumentStore, importLegacyJson } from "../../shared/PgDocumentStore";
import type { TxSource } from "../../db/pool";
import { AlertRulesWriteFailedError } from "./AlertRuleErrors";
import { AlertRuleFields, MAX_ALERT_RULES, readRuleFields } from "./AlertRuleValidation";

export interface AlertRule extends AlertRuleFields {
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Postgres document store for alert rules, keyed by rule id (see PgDocumentStore for the
 * load / transactional serialized write mechanics).
 */
export class AlertRuleStore {
  private store: PgDocumentStore<AlertRuleFields>;

  constructor(db?: TxSource) {
    this.store = new PgDocumentStore<AlertRuleFields>({
      db,
      scope: "AlertRuleStore",
      collection: "alert_rules",
      legacyProperty: "rules",
      entryLabel: "alert rule",
      max: MAX_ALERT_RULES,
      parseEntry: (id, raw) => (UUID_RE.test(id) ? readRuleFields(raw) : undefined),
      createWriteError: () => new AlertRulesWriteFailedError(),
    });
  }

  /** Reads the collection from the database. Throws on a db error (startup fails). */
  load(): Promise<void> {
    return this.store.load();
  }

  /** One-time import of the legacy JSON file (see importLegacyJson). */
  importLegacy(file: string): Promise<void> {
    return importLegacyJson(this.store, file);
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
