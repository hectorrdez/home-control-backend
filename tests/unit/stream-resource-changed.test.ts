import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appEvents } from "@shared/events/AppEvents";
import StreamController from "@modules/stream/StreamController";
import { silenceConsole } from "./helpers";

/** Minimal socket stand-in: Express req is an EventEmitter with `query`; res records writes. */
const openRequests: EventEmitter[] = [];

function fakeStream(query: Record<string, unknown> = {}) {
  const req: any = Object.assign(new EventEmitter(), { query });
  openRequests.push(req);
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
  return { req, res };
}

/** Starts the controller on a fake socket; the subscription stays until req 'close'. */
async function open(query: Record<string, unknown> = {}) {
  const { req, res } = fakeStream(query);
  await StreamController.stream(req, res);
  return { req, res };
}

const appFrames = (res: any) => res.writes.filter((w: string) => w.startsWith("event: resource_changed"));

beforeEach(() => {
  silenceConsole();
  // The route also subscribes to the HA hub; keep its WebSocket inert.
  vi.stubGlobal(
    "WebSocket",
    class {
      onmessage = null;
      onclose = null;
      onerror = null;
      send() {}
      close() {}
    }
  );
});

afterEach(() => {
  openRequests.splice(0).forEach((req) => req.emit("close"));
  vi.unstubAllGlobals();
});

describe("StreamController resource_changed frames", () => {
  it("writes an app event as event: <type> with the data minus type", async () => {
    const { res } = await open();
    appEvents.emit({ type: "resource_changed", resource: "aliases", keys: ["light.a"], by: "client-1" });
    expect(appFrames(res)).toEqual([
      'event: resource_changed\ndata: {"resource":"aliases","keys":["light.a"],"by":"client-1"}\n\n',
    ]);
  });

  it("ignores the domain filter for app events", async () => {
    const { res } = await open({ domain: "light" });
    appEvents.emit({ type: "resource_changed", resource: "calibrations", keys: ["cover.k"], by: null });
    expect(appFrames(res)).toHaveLength(1);
    expect(appFrames(res)[0]).toContain('"resource":"calibrations"');
  });

  it("sends keys: [] when there are more than 100 keys", async () => {
    const { res } = await open();
    const keys = Array.from({ length: 101 }, (_, i) => `light.e${i}`);
    appEvents.emit({ type: "resource_changed", resource: "aliases", keys, by: null });
    expect(appFrames(res)[0]).toContain('"keys":[]');
  });

  it("keeps exactly 100 keys", async () => {
    const { res } = await open();
    const keys = Array.from({ length: 100 }, (_, i) => `light.e${i}`);
    appEvents.emit({ type: "resource_changed", resource: "aliases", keys, by: null });
    expect(JSON.parse(appFrames(res)[0].split("data: ")[1]).keys).toHaveLength(100);
  });

  it("unsubscribes from the bus when the client closes", async () => {
    const { req, res } = await open();
    req.emit("close");
    appEvents.emit({ type: "resource_changed", resource: "aliases", keys: ["light.a"], by: null });
    expect(appFrames(res)).toHaveLength(0);
  });

  it("does not subscribe at all in ?once=1 smoke mode", async () => {
    const { res } = await open({ once: "1" });
    expect(res.writes).toEqual(['event: ready\ndata: {"domain":null}\n\n']);
    appEvents.emit({ type: "resource_changed", resource: "aliases", keys: ["light.a"], by: null });
    expect(res.write).toHaveBeenCalledTimes(1);
  });
});
