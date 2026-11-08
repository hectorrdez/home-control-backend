import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertService, Actor } from "@modules/alerts/AlertService";
import { RecentActions } from "@modules/alerts/RecentActions";
import { parseAlertQuery, parseTestFireBody } from "@modules/alerts/AlertValidation";
import { AlertNotFoundError, InvalidAlertQueryError, InvalidAlertError } from "@modules/alerts/AlertErrors";
import type { AlertRule } from "@modules/alert-rules/AlertRuleStore";
import type { NormalizedEntity } from "@modules/ha/HaStates";
import type { Queryable } from "@db/pool";
import { silenceConsole } from "./helpers";

const RULE_ID = "22222222-2222-4222-8222-222222222222";
const ALERT_ID = "33333333-3333-4333-8333-333333333333";
const ANY_ACTOR: Actor = { clientId: null, clientName: null };
const T0 = Date.parse("2026-01-01T12:00:00.000Z");

const light = (state: string, lastChanged = "2026-01-01T12:00:00.000Z"): NormalizedEntity => ({
  entityId: "light.kitchen",
  domain: "light",
  name: "Kitchen",
  state,
  attributes: {},
  area: null,
  areaName: null,
  deviceName: null,
  lastChanged,
});

type Row = Record<string, unknown>;
type Handler = (sql: string, params?: unknown[]) => { rows: Row[] };

function setup(opts: { rules?: AlertRule[]; handler?: Handler } = {}) {
  const rules: AlertRule[] = opts.rules ?? [];
  const handler: Handler = opts.handler ?? (() => ({ rows: [] }));
  const db = { query: vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params)) };
  const log = { record: vi.fn() };
  const bus = { emit: vi.fn() };
  const recent = new RecentActions();
  const clock = { t: T0 };
  const service = new AlertService({
    db: db as unknown as Queryable,
    log,
    rules: { list: () => rules },
    recent,
    bus,
    now: () => clock.t,
  });
  return { service, db, log, bus, recent, rules, clock };
}

const stateRule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: RULE_ID,
  entityId: "light.kitchen",
  trigger: { type: "state_becomes", value: "on" },
  level: "medium",
  ...over,
});

const alertRow = (over: Row = {}): Row => ({
  id: ALERT_ID,
  rule_id: null,
  entity_id: "light.kitchen",
  level: "high",
  text: "TEST",
  fired_at: "2026-01-01T12:00:00.000Z",
  acked_at: null,
  acked_by: null,
  client_id: null,
  ...over,
});

beforeEach(() => silenceConsole());
afterEach(() => vi.restoreAllMocks());

describe("AlertService evaluation", () => {
  it("seeds silently: the first sighting never fires", async () => {
    const { service, db, log, bus } = setup({ rules: [stateRule()] });
    expect(await service.onEntity(light("off"))).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
    expect(log.record).not.toHaveBeenCalled();
    expect(bus.emit).not.toHaveBeenCalled();
  });

  it("a firing is stored once, logged and emitted", async () => {
    const { service, db, log, bus } = setup({ rules: [stateRule()] });
    await service.onEntity(light("off"));
    const [alert] = await service.onEntity(light("on", "2026-01-01T12:00:05.000Z"));
    expect(alert).toMatchObject({ ruleId: RULE_ID, entityId: "light.kitchen", level: "medium", text: "BECOMES ON", ackedAt: null, clientId: null });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toMatch(/INSERT INTO alerts/);
    expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ type: "alert", source: "engine", entityId: "light.kitchen" }));
    expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledWith({ type: "alert", alert });
  });

  it("does not fire the same rule twice within the dedupe window", async () => {
    const { service, clock } = setup({ rules: [stateRule()] });
    await service.onEntity(light("off"));
    expect(await service.onEntity(light("on"))).toHaveLength(1);
    await service.onEntity(light("off"));
    clock.t += 500;
    expect(await service.onEntity(light("on"))).toHaveLength(0);
  });

  it("off never fires; a reseed silences the next change", async () => {
    const { service } = setup({ rules: [stateRule({ level: "off" })] });
    await service.onEntity(light("off"));
    expect(await service.onEntity(light("on"))).toEqual([]);
    service.reseed();
    await service.onEntity(light("off"));
    expect(await service.onEntity(light("on"))).toEqual([]);
  });

  it("applies rule changes made after start, read on every evaluation", async () => {
    const { service, rules } = setup({ rules: [] });
    await service.onEntity(light("off"));
    expect(await service.onEntity(light("on"))).toEqual([]);
    rules.push(stateRule());
    await service.onEntity(light("off"));
    expect(await service.onEntity(light("on"))).toHaveLength(1);
  });

  it("interacted fires only within 10 s of an action of that entity and carries the client id", async () => {
    const { service, recent, log, clock } = setup({ rules: [stateRule({ trigger: { type: "interacted" } })] });
    await service.onEntity(light("off"));
    recent.record("light.kitchen", { clientId: "tablet-1", clientName: "Tablet" }, clock.t);
    clock.t += 1_000;
    const [alert] = await service.onEntity(light("on"));
    expect(alert.clientId).toBe("tablet-1");
    expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ clientId: "tablet-1" }) }));

    // The entry was consumed: the next change is not interacted.
    clock.t += 1_000;
    await service.onEntity(light("off"));
    expect(await service.onEntity(light("on"))).toEqual([]);
  });

  it("an action older than 10 s does not make a change interacted", async () => {
    const { service, recent, clock } = setup({ rules: [stateRule({ trigger: { type: "interacted" } })] });
    await service.onEntity(light("off"));
    recent.record("light.kitchen", { clientId: "tablet-1", clientName: null }, clock.t);
    clock.t += 11_000;
    expect(await service.onEntity(light("on"))).toEqual([]);
  });

  it("an attribute-free repeat with the same state and lastChanged does not fire", async () => {
    const { service } = setup({ rules: [stateRule()] });
    await service.onEntity(light("off"));
    expect(await service.onEntity(light("off"))).toEqual([]);
  });
});

describe("AlertService ack, list and test-fire", () => {
  it("first ack sets fields and emits once; second ack is a no-op returning the first ack", async () => {
    let acked = false;
    const handler: Handler = (sql) => {
      if (sql.startsWith("UPDATE alerts SET acked_at")) {
        if (acked) return { rows: [] };
        acked = true; // the row is acked from here on, as the database would be
        return { rows: [{ id: ALERT_ID }] };
      }
      if (sql.includes("WHERE a.id = $1")) {
        return { rows: [alertRow(acked ? { acked_at: "2026-01-01T12:01:00.000Z", acked_by: "phone" } : {})] };
      }
      return { rows: [] };
    };
    const { service, bus, log } = setup({ handler });
    const first = await service.ack(ALERT_ID, { clientId: "phone", clientName: "Phone" });
    expect(first).toMatchObject({ ackedBy: "phone", ackedAt: "2026-01-01T12:01:00.000Z" });
    const again = await service.ack(ALERT_ID, { clientId: "tablet", clientName: null });
    expect(again).toMatchObject({ ackedBy: "phone", ackedAt: "2026-01-01T12:01:00.000Z" });
    const acks = bus.emit.mock.calls.filter(([evt]) => evt.type === "alert_acked");
    expect(acks).toHaveLength(1);
    expect(acks[0][0]).toMatchObject({ type: "alert_acked", id: ALERT_ID, ackedBy: "phone" });
    expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ type: "alert_acked" }));
  });

  it("ack of an unknown id throws alert_not_found", async () => {
    const { service } = setup();
    await expect(service.ack("44444444-4444-4444-8444-444444444444", ANY_ACTOR)).rejects.toBeInstanceOf(AlertNotFoundError);
  });

  it("ack-all acks every open alert and emits one frame each", async () => {
    const ids = ["55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
    const handler: Handler = (sql) => {
      if (sql.startsWith("UPDATE alerts SET acked_at")) return { rows: ids.map((id) => ({ id })) };
      return { rows: ids.map((id) => alertRow({ id, acked_at: "2026-01-01T12:02:00.000Z" })) };
    };
    const { service, bus } = setup({ handler });
    const acked = await service.ackAll({ clientId: "phone", clientName: null });
    expect(acked.map((a) => a.id)).toEqual(ids);
    expect(bus.emit.mock.calls.filter(([e]) => e.type === "alert_acked")).toHaveLength(2);
  });

  it("list reads open alerts by default and all with status=all", async () => {
    const { service, db } = setup();
    await service.list(parseAlertQuery({}));
    expect(db.query.mock.calls[0][0]).toMatch(/a\.acked_at IS NULL/);
    expect(db.query.mock.calls[0][1]).toEqual([50]);
    await service.list(parseAlertQuery({ status: "all", limit: "5" }));
    expect(db.query.mock.calls[1][0]).not.toMatch(/acked_at IS NULL/);
    expect(db.query.mock.calls[1][1]).toEqual([5]);
  });

  it("test-fire stores and emits with no rule id", async () => {
    const { service, bus } = setup();
    const alert = await service.testFire(parseTestFireBody({ entityId: "light.bruno", level: "medium", text: "hello" }), ANY_ACTOR);
    expect(alert).toMatchObject({ ruleId: null, entityId: "light.bruno", level: "medium", text: "hello" });
    expect(bus.emit).toHaveBeenCalledWith({ type: "alert", alert });
  });

  it("bad query and body are rejected", () => {
    expect(() => parseAlertQuery({ status: "bad" })).toThrow(InvalidAlertQueryError);
    expect(() => parseAlertQuery({ limit: "0" })).toThrow(InvalidAlertQueryError);
    expect(() => parseTestFireBody({ entityId: "light.x", level: "off", text: "x" })).toThrow(InvalidAlertError);
  });
});

describe("RecentActions", () => {
  it("take consumes the entry and respects the window", () => {
    const recent = new RecentActions();
    recent.record("light.a", { clientId: "c", clientName: null }, 1000);
    expect(recent.take("light.a", 1000 + 10_001)).toBeUndefined();
    recent.record("light.a", { clientId: "c", clientName: null }, 1000);
    expect(recent.take("light.a", 2000)?.clientId).toBe("c");
    expect(recent.take("light.a", 2000)).toBeUndefined();
  });
});
