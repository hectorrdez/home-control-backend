import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog, capPayload, MAX_PAYLOAD_BYTES, startConfigChangedRecorder } from "@modules/events/EventLog";
import { appEvents, AppEvent } from "@shared/events/AppEvents";
import Logger from "@utils/Logger";
import { silenceConsole } from "./helpers";

const ROW = { id: "42", ts: "2026-11-08T10:00:00.000Z" };

function fakeDb(impl?: (sql: string, params?: unknown[]) => Promise<unknown>) {
  const query = vi.fn(impl ?? (async () => ({ rows: [ROW], rowCount: 1 })));
  return { query };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let seen: AppEvent[];
let off: () => void;

beforeEach(() => {
  silenceConsole();
  seen = [];
  off = appEvents.subscribe((evt) => seen.push(evt));
});

afterEach(() => {
  off();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("EventLog.insert", () => {
  it("inserts the row with the right params and returns the API shape", async () => {
    const db = fakeDb();
    const log = new EventLog(db);
    const view = await log.insert({
      type: "action",
      source: "api",
      entityId: "light.salon",
      level: "info",
      payload: { action: "turn_on", ok: true },
      clientId: "123e4567-e89b-12d3-a456-426614174000",
      clientName: "Tablet",
    });
    expect(db.query.mock.calls[0][1]).toEqual([
      "action",
      "api",
      "123e4567-e89b-12d3-a456-426614174000",
      "Tablet",
      "light.salon",
      "info",
      JSON.stringify({ action: "turn_on", ok: true }),
    ]);
    expect(view).toEqual({
      id: "42",
      ts: "2026-11-08T10:00:00.000Z",
      type: "action",
      source: "api",
      entityId: "light.salon",
      level: "info",
      clientId: "123e4567-e89b-12d3-a456-426614174000",
      clientName: "Tablet",
      payload: { action: "turn_on", ok: true },
    });
  });

  it("defaults optional fields to null and payload to {}", async () => {
    const db = fakeDb();
    const view = await new EventLog(db).insert({ type: "config_changed", source: "api" });
    expect(db.query.mock.calls[0][1]).toEqual(["config_changed", "api", null, null, null, null, "{}"]);
    expect(view).toMatchObject({ entityId: null, level: null, clientId: null, clientName: null, payload: {} });
  });
});

describe("EventLog.record", () => {
  it("emits the stored row on the bus after the insert", async () => {
    const order: string[] = [];
    const db = fakeDb(async () => {
      order.push("insert");
      return { rows: [ROW], rowCount: 1 };
    });
    const emit = vi.spyOn(appEvents, "emit").mockImplementation(() => {
      order.push("emit");
    });
    new EventLog(db).record({ type: "action", source: "api", entityId: "light.a" });
    await flush();
    expect(order).toEqual(["insert", "emit"]);
    expect(emit).toHaveBeenCalledWith({
      type: "event",
      event: expect.objectContaining({ id: "42", type: "action", entityId: "light.a" }),
    });
  });

  it("returns before the insert settles (fire-and-forget)", () => {
    const db = fakeDb(() => new Promise(() => undefined));
    expect(() => new EventLog(db).record({ type: "action", source: "api" })).not.toThrow();
    expect(seen).toEqual([]);
  });

  it("swallows db errors, logs at most once a minute and drops the event", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
    const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined);
    const db = fakeDb(async () => {
      throw new Error("db down");
    });
    const log = new EventLog(db);

    expect(() => log.record({ type: "action", source: "api" })).not.toThrow();
    await flush();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("db down");

    log.record({ type: "action", source: "api" });
    await flush();
    expect(error).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-11-08T10:01:01Z"));
    log.record({ type: "action", source: "api" });
    await flush();
    expect(error).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([]);
  });

  it("does not throw when a bus listener fails inside publish", async () => {
    const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined);
    vi.spyOn(appEvents, "emit").mockImplementation(() => {
      throw new Error("listener boom");
    });
    new EventLog(fakeDb()).record({ type: "action", source: "api" });
    await flush();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("capPayload", () => {
  it("keeps payloads up to the 4 KB limit", () => {
    const payload = { text: "x".repeat(MAX_PAYLOAD_BYTES - 20) };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(capPayload(payload)).toBe(payload);
  });

  it("replaces bigger payloads with { truncated: true }", () => {
    expect(capPayload({ text: "x".repeat(MAX_PAYLOAD_BYTES + 1) })).toEqual({ truncated: true });
  });

  it("counts multi-byte characters by their UTF-8 size", () => {
    expect(capPayload({ text: "ñ".repeat(MAX_PAYLOAD_BYTES) })).toEqual({ truncated: true });
  });
});

describe("EventLog.list", () => {
  it("selects newest first with only the bound filters", async () => {
    const db = fakeDb(async () => ({
      rows: [
        {
          id: "9",
          ts: new Date("2026-11-08T10:00:00Z"),
          type: "action",
          source: "api",
          entity_id: "light.a",
          level: null,
          client_id: null,
          client_name: null,
          payload: { ok: true },
        },
      ],
      rowCount: 1,
    }));
    const rows = await new EventLog(db).list({
      types: ["action", "config_changed"],
      entityId: "light.a",
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-08",
      before: "100",
      limit: 5,
    });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("ORDER BY id DESC");
    expect(sql).toContain("type = ANY($1::text[])");
    expect(sql).toContain("entity_id = $2");
    expect(sql).toContain("ts >= $3::timestamptz");
    expect(sql).toContain("ts <= $4::timestamptz");
    expect(sql).toContain("id < $5::bigint");
    expect(sql).toContain("LIMIT $6");
    expect(sql).not.toMatch(/light\.a|action/);
    expect(params).toEqual([
      ["action", "config_changed"],
      "light.a",
      "2026-11-01T00:00:00Z",
      "2026-11-08",
      "100",
      5,
    ]);
    expect(rows).toEqual([
      {
        id: "9",
        ts: "2026-11-08T10:00:00.000Z",
        type: "action",
        source: "api",
        entityId: "light.a",
        level: null,
        clientId: null,
        clientName: null,
        payload: { ok: true },
      },
    ]);
  });

  it("has no WHERE clause when no filter is given", async () => {
    const db = fakeDb(async () => ({ rows: [], rowCount: 0 }));
    await new EventLog(db).list({ limit: 100 });
    expect(db.query.mock.calls[0][0]).not.toContain("WHERE");
    expect(db.query.mock.calls[0][1]).toEqual([100]);
  });
});

describe("startConfigChangedRecorder", () => {
  it("records config_changed for every resource_changed with by as clientId", async () => {
    const db = fakeDb();
    const log = new EventLog(db);
    const stop = startConfigChangedRecorder(log);
    try {
      appEvents.emit({ type: "resource_changed", resource: "settings", keys: ["ui.theme"], by: "client-1" });
      await flush();
      expect(db.query.mock.calls[0][1]).toEqual([
        "config_changed",
        "api",
        "client-1",
        null,
        null,
        null,
        JSON.stringify({ resource: "settings", keys: ["ui.theme"] }),
      ]);
    } finally {
      stop();
    }
  });

  it("ignores events that are not resource_changed and stops when unsubscribed", async () => {
    const db = fakeDb();
    const stop = startConfigChangedRecorder(new EventLog(db));
    appEvents.emit({ type: "event", event: { id: "1" } as any });
    await flush();
    expect(db.query).not.toHaveBeenCalled();
    stop();
    appEvents.emit({ type: "resource_changed", resource: "aliases", keys: [], by: null });
    await flush();
    expect(db.query).not.toHaveBeenCalled();
  });
});
