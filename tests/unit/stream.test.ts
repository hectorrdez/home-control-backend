import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silenceConsole, startApp } from "./helpers";

// Captured before any stub: the route tests call the real app over HTTP.
const realFetch = globalThis.fetch;

/** Scriptable stand-in for the browser/Node WebSocket used by the HA event hub. */
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

const stateEvent = (entity_id: string, state = "on", extra: Record<string, unknown> = {}) => ({
  type: "event",
  id: 1,
  event: {
    data: {
      new_state: { entity_id, state, last_changed: "2026-01-01T00:00:00+00:00", attributes: extra },
    },
  },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Loads a fresh hub + app so module-level singletons do not leak between tests. */
async function freshHub() {
  vi.resetModules();
  const { haEvents } = await import("@modules/stream/HaEvents");
  return haEvents;
}

let templateText = "light.kitchen|kitchen|Cocina\n";
/** The device-name template shares /api/template with the area template; route it apart. */
const deviceText = "light.kitchen|Mando cocina\n";

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(String(init?.body).includes("device_attr") ? deviceText : templateText, { status: 200 })
    )
  );
  process.env.HA_URL = "http://ha.test:8123/";
  process.env.HA_TOKEN = "hub-token";
  silenceConsole();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HaEventHub", () => {
  it("opens one WebSocket on the first subscriber, with http(s) mapped to ws(s)", async () => {
    const hub = await freshHub();
    hub.subscribe(() => undefined);
    hub.subscribe(() => undefined);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://ha.test:8123/api/websocket");
  });

  it("maps https to wss", async () => {
    process.env.HA_URL = "https://ha.example.com";
    const hub = await freshHub();
    hub.subscribe(() => undefined);
    expect(FakeWebSocket.instances[0].url).toBe("wss://ha.example.com/api/websocket");
  });

  it("authenticates with the token and subscribes to state_changed after auth_ok", async () => {
    const hub = await freshHub();
    hub.subscribe(() => undefined);
    const ws = FakeWebSocket.instances[0];
    ws.emit({ type: "auth_required" });
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "auth", access_token: "hub-token" });

    ws.emit({ type: "auth_ok" });
    expect(JSON.parse(ws.sent[1])).toEqual({ id: 1, type: "subscribe_events", event_type: "state_changed" });
  });

  it("maps a state_changed event to a normalized entity with its area, for each listener", async () => {
    const hub = await freshHub();
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe(a);
    hub.subscribe(b);
    const ws = FakeWebSocket.instances[0];
    ws.emit(stateEvent("light.kitchen", "off", { friendly_name: "Luz", brightness: 10, context: "x" }));
    await flush();

    const expected = {
      entityId: "light.kitchen",
      domain: "light",
      name: "Luz",
      state: "off",
      attributes: { friendly_name: "Luz", brightness: 10 },
      area: "kitchen",
      areaName: "Cocina",
      deviceName: "Mando cocina",
      lastChanged: "2026-01-01T00:00:00+00:00",
    };
    expect(a).toHaveBeenCalledWith(expected);
    expect(b).toHaveBeenCalledWith(expected);
  });

  it("still delivers the event with area null when the area lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const hub = await freshHub();
    const fn = vi.fn();
    hub.subscribe(fn);
    FakeWebSocket.instances[0].emit(stateEvent("switch.fan"));
    await flush();
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ entityId: "switch.fan", area: null, areaName: null }));
  });

  it("ignores events with no new_state, non-JSON frames, and events for other subscription ids", async () => {
    const hub = await freshHub();
    const fn = vi.fn();
    hub.subscribe(fn);
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: "not json" });
    ws.emit({ type: "event", id: 1, event: { data: { new_state: null } } });
    ws.emit({ type: "event", id: 99, event: { data: { new_state: { entity_id: "light.x", state: "on" } } } });
    ws.emit({ type: "result", id: 1 });
    await flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("closes the socket when HA rejects the token and does not reconnect while listeners remain", async () => {
    vi.useFakeTimers();
    const hub = await freshHub();
    hub.subscribe(() => undefined);
    const ws = FakeWebSocket.instances[0];
    ws.emit({ type: "auth_invalid" });
    expect(ws.closed).toBe(true);
    ws.onclose?.();
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reconnects with backoff (1s, 2s, ...) after an unexpected close while listened to", async () => {
    vi.useFakeTimers();
    const hub = await freshHub();
    hub.subscribe(() => undefined);

    FakeWebSocket.instances[0].onclose?.();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].onclose?.();
    vi.advanceTimersByTime(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("caps the backoff at 30s and resets it after auth_ok", async () => {
    vi.useFakeTimers();
    const hub = await freshHub();
    hub.subscribe(() => undefined);
    // 1s, 2s, 4s, 8s, 16s, 30s, 30s ...
    for (let i = 0; i < 7; i++) {
      FakeWebSocket.instances[FakeWebSocket.instances.length - 1].onclose?.();
      vi.advanceTimersByTime(30_000);
    }
    const before = FakeWebSocket.instances.length;
    FakeWebSocket.instances[before - 1].emit({ type: "auth_ok" });
    FakeWebSocket.instances[before - 1].onclose?.();
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it("stays idle and retries later when HA is not configured", async () => {
    vi.useFakeTimers();
    process.env.HA_URL = "";
    const hub = await freshHub();
    hub.subscribe(() => undefined);
    expect(FakeWebSocket.instances).toHaveLength(0);
    process.env.HA_URL = "http://ha.test:8123";
    process.env.HA_TOKEN = "hub-token";
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("closes the socket and cancels reconnects when the last listener leaves", async () => {
    vi.useFakeTimers();
    const hub = await freshHub();
    const off1 = hub.subscribe(() => undefined);
    const off2 = hub.subscribe(() => undefined);
    const ws = FakeWebSocket.instances[0];
    off1();
    expect(ws.closed).toBe(false);
    off2();
    expect(ws.closed).toBe(true);

    // The intentional close must not schedule a reconnect.
    ws.onclose?.();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("cancels a pending reconnect when the last listener leaves", async () => {
    vi.useFakeTimers();
    const hub = await freshHub();
    const off = hub.subscribe(() => undefined);
    FakeWebSocket.instances[0].onclose?.();
    off();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("opens a new socket after everyone unsubscribed and someone subscribes again", async () => {
    const hub = await freshHub();
    const off = hub.subscribe(() => undefined);
    off();
    hub.subscribe(() => undefined);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("tolerates an onerror event (close handles the reconnect)", async () => {
    const hub = await freshHub();
    hub.subscribe(() => undefined);
    expect(() => FakeWebSocket.instances[0].onerror?.()).not.toThrow();
  });
});

describe("GET /api/stream", () => {
  it("sends a ready event and ends when ?once=1", async () => {
    const app = await startApp();
    try {
      const res = await realFetch(`${app.base}/stream?once=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      await expect(res.text()).resolves.toBe('event: ready\ndata: {"domain":null}\n\n');
    } finally {
      await app.close();
    }
  });

  it("echoes a valid domain filter in the ready event", async () => {
    const app = await startApp();
    try {
      const res = await realFetch(`${app.base}/stream?once=1&domain=light`);
      await expect(res.text()).resolves.toBe('event: ready\ndata: {"domain":"light"}\n\n');
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid domain filter with 400 invalid_domain", async () => {
    const app = await startApp();
    try {
      const res = await realFetch(`${app.base}/stream?domain=Light!`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_domain");
      expect(body.status).toBe("rejected");
    } finally {
      await app.close();
    }
  });

  it("streams only the matching domain's state_changed events while connected", async () => {
    const app = await startApp();
    const ctrl = new AbortController();
    try {
      const res = await realFetch(`${app.base}/stream?domain=light`, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const readUntil = async (needle: string) => {
        while (!text.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value);
        }
      };

      await readUntil("event: ready");
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws = FakeWebSocket.instances[0];
      ws.emit(stateEvent("switch.fan", "on")); // filtered out
      ws.emit(stateEvent("light.kitchen", "off")); // delivered
      await readUntil("light.kitchen");

      expect(text).not.toContain("switch.fan");
      expect(text).toContain("event: state_changed");
      expect(text).toContain('"entityId":"light.kitchen"');
      expect(text).toContain('"state":"off"');

      ctrl.abort();
      await reader.cancel().catch(() => undefined);
    } finally {
      await app.close();
    }
  });
});
