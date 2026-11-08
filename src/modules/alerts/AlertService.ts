import { randomUUID } from "crypto";
import Logger from "@utils/Logger";
import { pool, Queryable } from "@db/pool";
import { appEvents, AppEvent } from "@shared/events/AppEvents";
import alertRuleStore, { AlertRule } from "@modules/alert-rules/AlertRuleStore";
import { eventLog as defaultLog, EventInput } from "@modules/events/EventLog";
import { haEvents, HaEventHub } from "@modules/stream/HaEvents";
import { NormalizedEntity } from "@modules/ha/HaStates";
import { evaluate, differs, EntityLike, FiringLevel, takeFirings } from "./engine";
import { RecentActions, recentActions as defaultRecent } from "./RecentActions";
import { AlertNotFoundError } from "./AlertErrors";
import { AlertQuery, TestFireBody } from "./AlertValidation";

/** An open alert is one not acknowledged and fired within this window. */
const OPEN_WINDOW = "24 hours";

/** API shape of one alert. `clientId` is the initiator of an interacted firing, else null. */
export interface AlertView {
  id: string;
  ruleId: string | null;
  entityId: string;
  level: FiringLevel;
  text: string;
  firedAt: string;
  ackedAt: string | null;
  ackedBy: string | null;
  clientId: string | null;
}

/** Who acted: the X-Client-Id / X-Client-Name of the request (null when unknown or timer-driven). */
export interface Actor {
  clientId: string | null;
  clientName: string | null;
}

export interface AlertServiceDeps {
  db?: Queryable;
  log?: { record(input: EventInput): void };
  rules?: { list(): AlertRule[] };
  recent?: RecentActions;
  bus?: { emit(evt: AppEvent): void };
  now?: () => number;
}

/** What one stored firing needs: a real rule (ruleId, trigger) or a test-fire (both null). */
interface StoredFiring {
  ruleId: string | null;
  entityId: string;
  level: FiringLevel;
  text: string;
  trigger: unknown;
}

/** Column list shared by every alert read. `clientId` comes from the `alert` event that logged the firing. */
const SELECT_ALERT = `
SELECT a.id, a.rule_id, a.entity_id, a.level, a.text, a.fired_at, a.acked_at, a.acked_by, e.client_id
FROM alerts a
LEFT JOIN LATERAL (
  SELECT client_id FROM events
  WHERE type = 'alert' AND payload->>'alertId' = a.id::text
  ORDER BY id DESC LIMIT 1
) e ON true`;

function toView(row: Record<string, unknown>): AlertView {
  return {
    id: String(row.id),
    ruleId: (row.rule_id as string | null) ?? null,
    entityId: String(row.entity_id),
    level: row.level as AlertView["level"],
    text: String(row.text),
    firedAt: new Date(row.fired_at as string).toISOString(),
    ackedAt: row.acked_at ? new Date(row.acked_at as string).toISOString() : null,
    ackedBy: (row.acked_by as string | null) ?? null,
    clientId: (row.client_id as string | null) ?? null,
  };
}

/**
 * Server-side alert engine (020). Keeps the previous normalized entity per id, evaluates
 * every live state change against the rules in memory, stores each firing once, logs it and
 * publishes it on the change bus. Seeding (the first sighting of an entity, or after a link
 * reconnect) is silent: it never fires.
 */
export class AlertService {
  private readonly last = new Map<string, EntityLike>();
  private readonly lastFired = new Map<string, number>();
  private readonly db: Queryable;
  private readonly log: { record(input: EventInput): void };
  private readonly rules: { list(): AlertRule[] };
  private readonly recent: RecentActions;
  private readonly bus: { emit(evt: AppEvent): void };
  private readonly now: () => number;

  constructor(deps: AlertServiceDeps = {}) {
    this.db = deps.db ?? pool;
    this.log = deps.log ?? defaultLog;
    this.rules = deps.rules ?? alertRuleStore;
    this.recent = deps.recent ?? defaultRecent;
    this.bus = deps.bus ?? appEvents;
    this.now = deps.now ?? Date.now;
  }

  /** Forgets the previous states so the next sighting of each entity only seeds (used on every link (re)connect). */
  reseed(): void {
    this.last.clear();
  }

  /** Evaluates one live entity state. Resolves with the alerts stored for it (empty for seeding and no-op changes). */
  async onEntity(entity: NormalizedEntity): Promise<AlertView[]> {
    const now = this.now();
    const before = this.last.get(entity.entityId);
    this.last.set(entity.entityId, entity);
    if (!before || !differs(before, entity)) return [];

    // One recent action explains at most one change of its entity, so it is consumed here.
    const action = this.recent.take(entity.entityId, now);
    const firings = takeFirings(evaluate(this.rules.list(), before, entity, { interacted: action !== undefined }), this.lastFired, now);

    const stored: AlertView[] = [];
    for (const firing of firings) {
      const clientId = firing.rule.trigger.type === "interacted" ? (action?.clientId ?? null) : null;
      try {
        stored.push(
          await this.store({ ruleId: firing.rule.id, entityId: firing.entityId, level: firing.level, text: firing.text, trigger: firing.rule.trigger }, clientId, now)
        );
      } catch (err) {
        Logger.error(`alert not stored: ${(err as Error)?.message ?? String(err)}`, "ALERTS");
      }
    }
    return stored;
  }

  /** Inserts one firing, logs it and publishes it. Throws on a db error (nothing is logged or emitted then). */
  private async store(firing: StoredFiring, clientId: string | null, now: number): Promise<AlertView> {
    const id = randomUUID();
    const firedAt = new Date(now).toISOString();
    await this.db.query(
      "INSERT INTO alerts (id, rule_id, entity_id, level, text, fired_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, firing.ruleId, firing.entityId, firing.level, firing.text, firedAt]
    );
    const view: AlertView = {
      id,
      ruleId: firing.ruleId,
      entityId: firing.entityId,
      level: firing.level,
      text: firing.text,
      firedAt,
      ackedAt: null,
      ackedBy: null,
      clientId,
    };
    this.log.record({
      type: "alert",
      source: "engine",
      entityId: firing.entityId,
      level: firing.level,
      clientId,
      payload: { alertId: id, ruleId: firing.ruleId, text: firing.text, trigger: firing.trigger, clientId },
    });
    this.bus.emit({ type: "alert", alert: view });
    return view;
  }

  /** Alerts newest first. `open` = not acknowledged and fired within OPEN_WINDOW. */
  async list(query: AlertQuery): Promise<AlertView[]> {
    const where = query.status === "open" ? `WHERE a.acked_at IS NULL AND a.fired_at > now() - interval '${OPEN_WINDOW}'` : "";
    const { rows } = await this.db.query(
      `${SELECT_ALERT} ${where} ORDER BY a.fired_at DESC, a.id DESC LIMIT $1`,
      [query.limit]
    );
    return rows.map(toView);
  }

  /** Acknowledges one alert. Idempotent: an alert already acked is returned unchanged and nothing is emitted. */
  async ack(id: string, actor: Actor): Promise<AlertView> {
    const { rows } = await this.db.query(
      "UPDATE alerts SET acked_at = now(), acked_by = $2 WHERE id = $1 AND acked_at IS NULL RETURNING id",
      [id, actor.clientId]
    );
    if (rows.length === 0) {
      const current = await this.get(id);
      if (!current) throw new AlertNotFoundError();
      return current;
    }
    const view = await this.get(id);
    if (!view) throw new AlertNotFoundError();
    this.announceAcked([view], actor);
    return view;
  }

  /** Acknowledges every open alert. Returns the alerts it acked (one `alert_acked` per alert). */
  async ackAll(actor: Actor): Promise<AlertView[]> {
    const { rows } = await this.db.query(
      `UPDATE alerts SET acked_at = now(), acked_by = $1 WHERE acked_at IS NULL AND fired_at > now() - interval '${OPEN_WINDOW}' RETURNING id`,
      [actor.clientId]
    );
    if (rows.length === 0) return [];
    const { rows: views } = await this.db.query(
      `${SELECT_ALERT} WHERE a.id = ANY($1::uuid[]) ORDER BY a.fired_at DESC, a.id DESC`,
      [rows.map((r: { id: string }) => r.id)]
    );
    const acked = views.map(toView);
    this.announceAcked(acked, actor);
    return acked;
  }

  /** Non-production hook: stores and publishes an alert as if a rule had fired (HA cannot be forced in tests). */
  async testFire(body: TestFireBody, actor: Actor): Promise<AlertView> {
    return this.store(
      { ruleId: null, entityId: body.entityId, level: body.level, text: body.text, trigger: null },
      actor.clientId,
      this.now()
    );
  }

  private async get(id: string): Promise<AlertView | undefined> {
    const { rows } = await this.db.query(`${SELECT_ALERT} WHERE a.id = $1`, [id]);
    return rows.length > 0 ? toView(rows[0]) : undefined;
  }

  private announceAcked(alerts: AlertView[], actor: Actor): void {
    for (const alert of alerts) {
      this.bus.emit({ type: "alert_acked", id: alert.id, ackedAt: alert.ackedAt ?? new Date(this.now()).toISOString(), ackedBy: alert.ackedBy });
      this.log.record({
        type: "alert_acked",
        source: "api",
        entityId: alert.entityId,
        clientId: actor.clientId,
        clientName: actor.clientName,
        payload: { alertId: alert.id },
      });
    }
  }
}

export const alertService = new AlertService();

/**
 * Subscribes the service to the always-on HA hub (019). Returns a function that stops it.
 * A link (re)connect reseeds silently, so a reconnect never fires alerts.
 */
export function startAlertService(hub: HaEventHub = haEvents, service: AlertService = alertService): () => void {
  const offLink = hub.onLink((connected) => {
    if (connected) service.reseed();
  });
  const offState = hub.subscribe((entity) => {
    service.onEntity(entity).catch((err: unknown) => {
      Logger.error(`alert evaluation failed: ${(err as Error)?.message ?? String(err)}`, "ALERTS");
    });
  });
  return () => {
    offLink();
    offState();
  };
}
