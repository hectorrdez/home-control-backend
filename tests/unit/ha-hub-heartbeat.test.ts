import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silenceConsole } from "./helpers";

/** Minimal WebSocket double: the test drives onmessage/onclose by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: any[] = [];
  close = vi.fn();
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

/** Opens the socket and completes auth, so the heartbeat starts. */
function authenticate(ws: FakeWebSocket) {
  ws.emit({ type: "auth_required" });
  ws.emit({ type: "auth_ok" });
}

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "test-ha-token";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function loadHub() {
  vi.resetModules();
  const { HaEventHub } = await import("@modules/stream/HaEvents");
  const hub = new HaEventHub();
  hub.keepAlive();
  return hub;
}

describe("HaEventHub heartbeat", () => {
  it("sends a ping every 30 s with ids that start at 2 (subscribe keeps id 1)", async () => {
    const hub = await loadHub();
    const ws = FakeWebSocket.instances[0];
    authenticate(ws);
    expect(ws.sent.find((m) => m.type === "subscribe_events")?.id).toBe(1);

    vi.advanceTimersByTime(30_000);
    const ping = ws.sent.find((m) => m.type === "ping");
    expect(ping).toEqual({ id: 2, type: "ping" });

    ws.emit({ type: "pong", id: 2 });
    vi.advanceTimersByTime(30_000);
    expect(ws.sent.filter((m) => m.type === "ping").map((m) => m.id)).toEqual([2, 3]);
    expect(hub.status.connected).toBe(true);
  });

  it("keeps the socket open while pongs arrive", async () => {
    await loadHub();
    const ws = FakeWebSocket.instances[0];
    authenticate(ws);
    vi.advanceTimersByTime(30_000);
    ws.emit({ type: "pong", id: 2 });
    vi.advanceTimersByTime(20_000);
    expect(ws.close).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("closes a socket with no pong within 10 s and reconnects through the backoff", async () => {
    const hub = await loadHub();
    const linked: boolean[] = [];
    hub.onLink((c) => linked.push(c));
    const ws = FakeWebSocket.instances[0];
    authenticate(ws);

    vi.advanceTimersByTime(30_000); // ping sent, pong timer armed
    vi.advanceTimersByTime(10_000); // no pong
    expect(ws.close).toHaveBeenCalled();
    expect(linked).toEqual([true, false]);

    vi.advanceTimersByTime(1_000); // first backoff step
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].emit({ type: "auth_required" });
    FakeWebSocket.instances[1].emit({ type: "auth_ok" });
    expect(linked).toEqual([true, false, true]);
  });

  it("stops pinging once the hub has been closed on purpose", async () => {
    const hub = await loadHub();
    const ws = FakeWebSocket.instances[0];
    authenticate(ws);
    // a permanent hub never closes on purpose; a detached socket must simply stop its heartbeat.
    (hub as any).ws = null;
    vi.advanceTimersByTime(30_000);
    expect(ws.sent.filter((m) => m.type === "ping")).toHaveLength(0);
  });
});
