import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "@shared/events/AppEvents";
import { silenceConsole } from "./helpers";

/** Scriptable WebSocket stand-in for the HA hub. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  closed = false;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const stateEvent = (entity_id: string, state: string) => ({
  type: "event",
  id: 1,
  event: { data: { new_state: { entity_id, state, last_changed: "2026-01-01T00:00:00+00:00", attributes: {} } } },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Fake event log: records every input so tests can assert on what would be written. */
function fakeLog() {
  return { record: vi.fn() };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "hub-token";
  silenceConsole();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function freshHub() {
  vi.resetModules();
  const { haEvents } = await import("@modules/stream/HaEvents");
  return haEvents;
}

describe("HaEventHub keepAlive and link", () => {
  it("opens the socket at boot with keepAlive and keeps it open when the last listener leaves", async () => {
    const hub = await freshHub();
    hub.keepAlive();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const off = hub.subscribe(() => undefined);
    off();
    expect(FakeWebSocket.instances[0].closed).toBe(false);
  });

  it("keeps reconnecting forever after keepAlive, even with no listeners", async () => {
    vi.useFakeTimers();
    const hub = await freshHub();
    hub.keepAlive();
    FakeWebSocket.instances[0].onclose?.();
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].onclose?.();
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("does not reconnect on its own without keepAlive or listeners", async () => {
    vi.useFakeTimers();
    const hub = await freshHub();
    const off = hub.subscribe(() => undefined);
    off();
    FakeWebSocket.instances[0].onclose?.();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("fires link callbacks once per real transition: true after auth_ok, false on close", async () => {
    vi.useFakeTimers();
    const hub = await freshHub();
    const fn = vi.fn();
    hub.onLink(fn);
    hub.keepAlive();
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: "auth_ok" });
    ws.emit({ type: "auth_ok" });
    expect(fn.mock.calls).toEqual([[true]]);
    expect(hub.status.connected).toBe(true);
    expect(hub.status.at).not.toBeNull();

    ws.onclose?.();
    ws.onclose?.();
    expect(fn.mock.calls).toEqual([[true], [false]]);
    expect(hub.status.connected).toBe(false);
  });

  it("reports false on auth_invalid and does not repeat it on the close that follows", async () => {
    const hub = await freshHub();
    const fn = vi.fn();
    hub.onLink(fn);
    hub.keepAlive();
    const ws = FakeWebSocket.instances[0];
    ws.emit({ type: "auth_ok" });
    ws.emit({ type: "auth_invalid" });
    ws.onclose?.();
    expect(fn.mock.calls).toEqual([[true], [false]]);
  });

  it("stops notifying after unsubscribe and survives a throwing link listener", async () => {
    const hub = await freshHub();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    hub.onLink(bad);
    const offGood = hub.onLink(good);
    hub.keepAlive();
    FakeWebSocket.instances[0].emit({ type: "auth_ok" });
    expect(good).toHaveBeenCalledWith(true);
    offGood();
    FakeWebSocket.instances[0].onclose?.();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("reports a disconnected status before any transition", async () => {
    const hub = await freshHub();
    expect(hub.status).toEqual({ connected: false, at: null });
  });
});

describe("AvailabilityRecorder", () => {
  async function load() {
    vi.resetModules();
    const { AvailabilityRecorder, AVAILABILITY_GUARD_MS } = await import("@modules/events/AvailabilityRecorder");
    const log = fakeLog();
    return { rec: new AvailabilityRecorder(log), log, AVAILABILITY_GUARD_MS };
  }

  it("seeds the first sighting silently and records nothing", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "unavailable" }, 0);
    expect(log.record).not.toHaveBeenCalled();
  });

  it("records to unavailable with the previous state, and back with the new state", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    rec.observe({ entityId: "light.a", state: "unavailable" }, 1);
    rec.observe({ entityId: "light.a", state: "off" }, 20_000);
    expect(log.record.mock.calls).toEqual([
      [{ type: "availability", source: "ha", entityId: "light.a", payload: { available: false, from: "on" } }],
      [{ type: "availability", source: "ha", entityId: "light.a", payload: { available: true, to: "off" } }],
    ]);
  });

  it("ignores changes between two available states", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    rec.observe({ entityId: "light.a", state: "off" }, 20_000);
    rec.observe({ entityId: "light.a", state: "on" }, 40_000);
    expect(log.record).not.toHaveBeenCalled();
  });

  it("drops a second availability event for the same entity within 10 s", async () => {
    const { rec, log, AVAILABILITY_GUARD_MS } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    rec.observe({ entityId: "light.a", state: "unavailable" }, 1_000);
    rec.observe({ entityId: "light.a", state: "on" }, 2_000);
    expect(log.record).toHaveBeenCalledTimes(1);

    // The window is measured from the last recorded event, so it opens again after 10 s.
    rec.observe({ entityId: "light.a", state: "unavailable" }, 1_000 + AVAILABILITY_GUARD_MS);
    expect(log.record).toHaveBeenCalledTimes(2);
  });

  it("keeps the latest state in memory even when the event is dropped", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    rec.observe({ entityId: "light.a", state: "unavailable" }, 1_000);
    rec.observe({ entityId: "light.a", state: "off" }, 2_000); // dropped by the guard, memory now "off"
    rec.observe({ entityId: "light.a", state: "unavailable" }, 3_000); // from "off", also dropped
    expect(log.record).toHaveBeenCalledTimes(1);
  });

  it("does not guard different entities against each other", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    rec.observe({ entityId: "light.b", state: "on" }, 0);
    rec.observe({ entityId: "light.a", state: "unavailable" }, 1_000);
    rec.observe({ entityId: "light.b", state: "unavailable" }, 1_000);
    expect(log.record).toHaveBeenCalledTimes(2);
  });

  it("resync seeds unknown entities silently and records missed transitions with resync: true", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    rec.resync(
      [
        { entity_id: "light.a", state: "unavailable" },
        { entity_id: "light.new", state: "unavailable" },
      ],
      100_000
    );
    expect(log.record.mock.calls).toEqual([
      [
        {
          type: "availability",
          source: "ha",
          entityId: "light.a",
          payload: { available: false, from: "on", resync: true },
        },
      ],
    ]);
  });

  it("resync on an empty memory seeds silently and records nothing", async () => {
    const { rec, log } = await load();
    rec.resync([
      { entity_id: "light.a", state: "unavailable" },
      { entity_id: "light.b", state: "on" },
    ]);
    expect(log.record).not.toHaveBeenCalled();
  });

  it("does not let an older connection's snapshot replace a newer live state", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    const first = rec.mark(); // first connection starts a snapshot
    rec.observe({ entityId: "light.a", state: "unavailable" }, 1);
    rec.mark(); // reconnect starts another snapshot before the first resolves
    rec.resync([{ entity_id: "light.a", state: "on" }], 20_000, first); // first snapshot arrives late
    rec.observe({ entityId: "light.a", state: "unavailable" }, 40_000);
    expect(log.record).toHaveBeenCalledTimes(1);
  });

  it("discards a snapshot whose token is older than the latest, even with a token", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    const first = rec.mark();
    const second = rec.mark();
    rec.resync([{ entity_id: "light.a", state: "unavailable" }], 20_000, first);
    expect(log.record).not.toHaveBeenCalled();
    rec.resync([{ entity_id: "light.a", state: "unavailable" }], 20_000, second);
    expect(log.record).toHaveBeenCalledTimes(1);
    // Token already consumed: a replay is stale.
    rec.resync([{ entity_id: "light.a", state: "on" }], 40_000, second);
    expect(log.record).toHaveBeenCalledTimes(1);
  });

  it("cancel releases a mark: a failed snapshot leaves nothing pending and the next one still applies", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    const failed = rec.mark();
    rec.cancel(failed);
    rec.resync([{ entity_id: "light.a", state: "unavailable" }], 20_000, failed); // cancelled token is dropped
    expect(log.record).not.toHaveBeenCalled();
    const next = rec.mark();
    rec.resync([{ entity_id: "light.a", state: "unavailable" }], 20_000, next);
    expect(log.record).toHaveBeenCalledTimes(1);
  });

  it("ignores a duplicate or cancelled token without consuming another pending snapshot", async () => {
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" }, 0);
    const cancelled = rec.mark();
    rec.cancel(cancelled);
    rec.cancel(cancelled); // cancelling an unknown token is harmless
    const current = rec.mark();
    rec.resync([{ entity_id: "light.a", state: "unavailable" }], 20_000, cancelled);
    expect(log.record).not.toHaveBeenCalled();
    rec.resync([{ entity_id: "light.a", state: "unavailable" }], 20_000, current);
    rec.resync([{ entity_id: "light.a", state: "on" }], 40_000, current);
    expect(log.record).toHaveBeenCalledTimes(1);
  });

  it("prunes entities missing from a snapshot after PRUNE_AFTER_MS, keeping seen and recent ones", async () => {
    vi.resetModules();
    const { AvailabilityRecorder, PRUNE_AFTER_MS } = await import("@modules/events/AvailabilityRecorder");
    const log = fakeLog();
    const rec = new AvailabilityRecorder(log);
    rec.observe({ entityId: "light.gone", state: "on" }, 0);
    rec.observe({ entityId: "light.recent", state: "on" }, PRUNE_AFTER_MS);
    rec.resync([{ entity_id: "light.kept", state: "on" }], PRUNE_AFTER_MS + 1);
    // light.gone was forgotten: coming back unavailable is a first sighting (silent seed), not a transition.
    rec.observe({ entityId: "light.gone", state: "unavailable" }, PRUNE_AFTER_MS + 2);
    expect(log.record).not.toHaveBeenCalled();
    // light.recent was kept: its transition is recorded.
    rec.observe({ entityId: "light.recent", state: "unavailable" }, PRUNE_AFTER_MS + 3);
    expect(log.record).toHaveBeenCalledTimes(1);
  });

  it("does not restore a pruned entity from an older pending snapshot", async () => {
    vi.resetModules();
    const { AvailabilityRecorder, PRUNE_AFTER_MS } = await import("@modules/events/AvailabilityRecorder");
    const log = fakeLog();
    const rec = new AvailabilityRecorder(log);
    rec.observe({ entityId: "light.gone", state: "on" }, 0);
    const old = rec.mark();
    const latest = rec.mark();
    rec.resync([], PRUNE_AFTER_MS + 1, latest);
    rec.resync([{ entity_id: "light.gone", state: "on" }], PRUNE_AFTER_MS + 2, old);
    rec.observe({ entityId: "light.gone", state: "unavailable" }, PRUNE_AFTER_MS + 3);
    expect(log.record).not.toHaveBeenCalled();
  });

  it("uses the wall clock when no time is given", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { rec, log } = await load();
    rec.observe({ entityId: "light.a", state: "on" });
    rec.observe({ entityId: "light.a", state: "unavailable" });
    expect(log.record).toHaveBeenCalledTimes(1);
  });
});

describe("startHaRecorder", () => {
  it("drops an older connection snapshot after the newer one finishes, using the real recorder tokens", async () => {
    vi.resetModules();
    const { startHaRecorder } = await import("@modules/events/HaRecorder");
    const { HaEventHub } = await import("@modules/stream/HaEvents");
    const { AvailabilityRecorder } = await import("@modules/events/AvailabilityRecorder");
    const log = fakeLog();
    const availability = new AvailabilityRecorder(log);
    availability.observe({ entityId: "light.a", state: "on" }, 0);
    const finish: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => finish.push(resolve))));
    const hub = new HaEventHub();
    const stop = startHaRecorder(hub, log as any, availability);

    vi.useFakeTimers();
    hub.keepAlive();
    FakeWebSocket.instances[0].emit({ type: "auth_ok" });
    FakeWebSocket.instances[0].onclose?.();
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances[1].emit({ type: "auth_ok" });
    vi.useRealTimers();
    expect(finish).toHaveLength(2);

    finish[1](new Response(JSON.stringify([{ entity_id: "light.a", state: "on" }]), { status: 200 }));
    await flush();
    finish[0](new Response(JSON.stringify([{ entity_id: "light.a", state: "unavailable" }]), { status: 200 }));
    await flush();
    availability.observe({ entityId: "light.a", state: "unavailable" }, 20_000);
    expect(log.record.mock.calls.filter(([event]) => event.type === "availability")).toEqual([
      [{ type: "availability", source: "ha", entityId: "light.a", payload: { available: false, from: "on" } }],
    ]);
    stop();
  });

  it("does not replay a stale snapshot over a newer live availability state", async () => {
    vi.resetModules();
    const { startHaRecorder } = await import("@modules/events/HaRecorder");
    const { HaEventHub } = await import("@modules/stream/HaEvents");
    const { AvailabilityRecorder } = await import("@modules/events/AvailabilityRecorder");
    const log = fakeLog();
    const availability = new AvailabilityRecorder(log);
    availability.observe({ entityId: "light.a", state: "on" }, 0);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    let finishSnapshot!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finishSnapshot = resolve; })));
    const hub = new HaEventHub();
    const stop = startHaRecorder(hub, log as any, availability);

    hub.keepAlive();
    FakeWebSocket.instances[0].emit({ type: "auth_ok" });
    // Snapshot saw "on" before this newer live transition, but resolves afterward.
    availability.observe({ entityId: "light.a", state: "unavailable" }, 1);
    finishSnapshot(new Response(JSON.stringify([{ entity_id: "light.a", state: "on" }]), { status: 200 }));
    await flush();
    await flush();
    // The stale snapshot was guarded, but must not replace the newer state in memory.
    availability.observe({ entityId: "light.a", state: "unavailable" }, 11_000);

    expect(log.record.mock.calls).toEqual([
      [{ type: "ha_link", source: "ha", payload: { connected: true } }],
      [{ type: "availability", source: "ha", entityId: "light.a", payload: { available: false, from: "on" } }],
    ]);
    stop();
  });

  it("logs and publishes each link transition, and resyncs the snapshot on connect", async () => {
    vi.resetModules();
    const { startHaRecorder } = await import("@modules/events/HaRecorder");
    const { HaEventHub } = await import("@modules/stream/HaEvents");
    const hub = new HaEventHub();
    const log = fakeLog();
    const resync = vi.fn();
    const availability = { observe: vi.fn(), mark: vi.fn(() => 7), cancel: vi.fn(), resync } as any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ entity_id: "light.a", state: "on" }]), { status: 200 }))
    );

    // Same module instance as the recorder: the reset above gives it a fresh bus.
    const { appEvents: bus } = await import("@shared/events/AppEvents");
    const published: AppEvent[] = [];
    const unsub = bus.subscribe((evt) => published.push(evt));
    const stop = startHaRecorder(hub, log as any, availability);

    hub.keepAlive();
    FakeWebSocket.instances[0].emit({ type: "auth_ok" });
    await flush();
    await flush();
    FakeWebSocket.instances[0].onclose?.();

    expect(log.record.mock.calls).toEqual([
      [{ type: "ha_link", source: "ha", payload: { connected: true } }],
      [{ type: "ha_link", source: "ha", payload: { connected: false } }],
    ]);
    const ha = published.filter((e) => e.type === "ha_link");
    expect(ha.map((e) => (e.type === "ha_link" ? e.connected : null))).toEqual([true, false]);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledWith([{ entity_id: "light.a", state: "on" }], undefined, 7);

    unsub();
    stop();
  });

  it("feeds the availability recorder with live state changes", async () => {
    vi.resetModules();
    const { startHaRecorder } = await import("@modules/events/HaRecorder");
    const { HaEventHub } = await import("@modules/stream/HaEvents");
    const hub = new HaEventHub();
    const availability = { observe: vi.fn(), mark: vi.fn(() => 7), cancel: vi.fn(), resync: vi.fn() } as any;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const stop = startHaRecorder(hub, fakeLog() as any, availability);

    hub.keepAlive();
    FakeWebSocket.instances[0].emit({ type: "auth_ok" });
    FakeWebSocket.instances[0].emit(stateEvent("switch.fan", "unavailable"));
    await flush();
    await flush();
    expect(availability.observe).toHaveBeenCalledWith({ entityId: "switch.fan", state: "unavailable" });
    stop();
  });

  it("logs a warning and keeps going when the snapshot fails", async () => {
    vi.resetModules();
    const { startHaRecorder } = await import("@modules/events/HaRecorder");
    const { HaEventHub } = await import("@modules/stream/HaEvents");
    const hub = new HaEventHub();
    const availability = { observe: vi.fn(), mark: vi.fn(() => 7), cancel: vi.fn(), resync: vi.fn() } as any;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const stop = startHaRecorder(hub, fakeLog() as any, availability);

    hub.keepAlive();
    FakeWebSocket.instances[0].emit({ type: "auth_ok" });
    await flush();
    await flush();
    expect(availability.resync).not.toHaveBeenCalled();
    expect(availability.cancel).toHaveBeenCalledWith(7);
    stop();
  });
});

describe("GET /api/stream ha_link frames", () => {
  async function openStream(query: Record<string, unknown> = {}) {
    vi.resetModules();
    const { default: StreamController } = await import("@modules/stream/StreamController");
    const { EventEmitter: Emitter } = await import("events");
    const req: any = Object.assign(new Emitter(), { query });
    const res: any = {
      headersSent: false,
      writes: [] as string[],
      writeHead: vi.fn(),
      end: vi.fn(),
      write: vi.fn((chunk: string) => {
        res.writes.push(chunk);
        return true;
      }),
    };
    await StreamController.stream(req, res);
    return { req, res };
  }

  it("sends the current link state right after ready, as one ha_link frame", async () => {
    const { res, req } = await openStream();
    expect(res.writes[0]).toBe('event: ready\ndata: {"domain":null}\n\n');
    expect(res.writes[1]).toBe('event: ha_link\ndata: {"connected":false,"at":null}\n\n');
    req.emit("close");
  });

  it("does not send ha_link in ?once=1 smoke mode", async () => {
    const { res } = await openStream({ once: "1" });
    expect(res.writes).toEqual(['event: ready\ndata: {"domain":null}\n\n']);
  });

  it("writes a published ha_link app event as event: ha_link with connected and at", async () => {
    const { res, req } = await openStream();
    const { appEvents: bus } = await import("@shared/events/AppEvents");
    bus.emit({ type: "ha_link", connected: true, at: "2026-11-08T10:00:00.000Z" });
    expect(res.writes).toContain('event: ha_link\ndata: {"connected":true,"at":"2026-11-08T10:00:00.000Z"}\n\n');
    req.emit("close");
  });

  it("stops sending app events after the stream closes", async () => {
    const { res, req } = await openStream();
    const { appEvents: bus } = await import("@shared/events/AppEvents");
    req.emit("close");
    const writes = res.writes.length;
    bus.emit({ type: "ha_link", connected: true, at: "2026-11-08T10:00:00.000Z" });
    expect(res.writes).toHaveLength(writes);
  });
});
