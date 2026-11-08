import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silenceConsole } from "./helpers";

type Sent = { id: number; type: string; [k: string]: unknown };

/** Records every command the cache sends and hands out increasing ids, like the hub does. */
function fakeSend() {
  const sent: Sent[] = [];
  let next = 1;
  const send = (payload: Record<string, unknown>): number => {
    const id = ++next;
    sent.push({ ...payload, id } as Sent);
    return id;
  };
  return { sent, send };
}

/** Answers the list request of `type` with `rows`, using the id the cache sent. */
function answer(cache: { onResult: (m: any) => boolean }, sent: Sent[], type: string, rows: unknown) {
  const req = [...sent].reverse().find((m) => m.type === type);
  if (!req) throw new Error(`no ${type} request sent`);
  return cache.onResult({ id: req.id, type: "result", success: true, result: rows });
}

/** Completes the four initial loads with the given data. */
function loadAll(cache: any, sent: Sent[], data: Partial<Record<"states" | "areas" | "devices" | "entities", any[]>> = {}) {
  answer(cache, sent, "get_states", data.states ?? []);
  answer(cache, sent, "config/area_registry/list", data.areas ?? []);
  answer(cache, sent, "config/device_registry/list", data.devices ?? []);
  answer(cache, sent, "config/entity_registry/list", data.entities ?? []);
}

const S = (entity_id: string, state: string, last_updated = "2026-01-01T10:00:00+00:00") => ({
  entity_id,
  state,
  attributes: {},
  last_changed: last_updated,
  last_updated,
});

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadCache() {
  vi.resetModules();
  const mod = await import("@modules/ha/HaCache");
  return new mod.HaCache();
}

describe("HaCache load sequence", () => {
  it("requests the four lists and subscribes to registry events on start", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);

    expect(sent.map((m) => m.type)).toEqual([
      "get_states",
      "config/area_registry/list",
      "config/device_registry/list",
      "config/entity_registry/list",
      "subscribe_events",
      "subscribe_events",
      "subscribe_events",
    ]);
    expect(sent.filter((m) => m.type === "subscribe_events").map((m) => m.event_type)).toEqual([
      "area_registry_updated",
      "device_registry_updated",
      "entity_registry_updated",
    ]);
  });

  it("is warming until all four replies arrive, then ready", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    expect(cache.status()).toBe("off");
    cache.start(send);
    expect(cache.status()).toBe("warming");

    answer(cache, sent, "get_states", [S("light.a", "on")]);
    answer(cache, sent, "config/area_registry/list", []);
    answer(cache, sent, "config/device_registry/list", []);
    expect(cache.isReady()).toBe(false);
    answer(cache, sent, "config/entity_registry/list", []);
    expect(cache.isReady()).toBe(true);
    expect(cache.status()).toBe("ready");
  });

  it("ignores results that are not its own ids", async () => {
    const cache = await loadCache();
    const { send } = fakeSend();
    cache.start(send);
    expect(cache.onResult({ id: 999, type: "result", success: true, result: [] })).toBe(false);
  });

  it("goes back to off on disconnect and forgets the data", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent, { states: [S("light.a", "on")] });
    expect(cache.isReady()).toBe(true);

    cache.onDisconnect();
    expect(cache.status()).toBe("off");
    expect(cache.isReady()).toBe(false);
    expect(cache.state("light.a")).toBeNull();
  });

  it("retries a failed list after 5 s", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    const req = sent.find((m) => m.type === "get_states")!;
    cache.onResult({ id: req.id, type: "result", success: false });
    expect(sent.filter((m) => m.type === "get_states")).toHaveLength(1);

    vi.advanceTimersByTime(5_000);
    expect(sent.filter((m) => m.type === "get_states")).toHaveLength(2);
  });
});

describe("HaCache area and device resolution", () => {
  it("entity area wins over device area; device area is used when the entity has none", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent, {
      areas: [
        { area_id: "kitchen", name: "Cocina" },
        { area_id: "bedroom", name: "Dormitorio" },
      ],
      devices: [{ id: "dev1", area_id: "kitchen", name: "Lamp" }],
      entities: [
        { entity_id: "light.a", device_id: "dev1", area_id: "bedroom" },
        { entity_id: "light.b", device_id: "dev1", area_id: null },
        { entity_id: "light.c", area_id: null, device_id: null },
      ],
    });

    expect(cache.areas().get("light.a")).toEqual({ areaId: "bedroom", areaName: "Dormitorio" });
    expect(cache.areas().get("light.b")).toEqual({ areaId: "kitchen", areaName: "Cocina" });
    expect(cache.areas().has("light.c")).toBe(false);
  });

  it("area names come from the area registry and fall back to the id", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent, {
      areas: [{ area_id: "garage", name: null }, { area_id: "attic", name: "Desván" }],
      entities: [{ entity_id: "switch.x", area_id: "garage" }],
    });
    expect(cache.areas().get("switch.x")).toEqual({ areaId: "garage", areaName: "garage" });
    expect(cache.areaEntries()).toEqual([
      { areaId: "garage", areaName: "garage" },
      { areaId: "attic", areaName: "Desván" },
    ]);
  });

  it("device name is name_by_user over name", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent, {
      devices: [
        { id: "d1", name: "Hue bridge", name_by_user: "Puente luz" },
        { id: "d2", name: "Sensor", name_by_user: null },
      ],
      entities: [
        { entity_id: "light.a", device_id: "d1" },
        { entity_id: "sensor.b", device_id: "d2" },
      ],
    });
    expect(cache.devices().get("light.a")).toBe("Puente luz");
    expect(cache.devices().get("sensor.b")).toBe("Sensor");
  });
});

describe("HaCache states", () => {
  it("state_changed updates and deletes entries", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent, { states: [S("light.a", "on", "2026-01-01T10:00:00+00:00")] });

    cache.onStateChanged({ entity_id: "light.a", new_state: S("light.a", "off", "2026-01-01T10:05:00+00:00") });
    expect(cache.state("light.a")?.state).toBe("off");

    cache.onStateChanged({ entity_id: "light.a", new_state: null });
    expect(cache.state("light.a")).toBeNull();
    expect(cache.allStates()).toEqual([]);
  });

  it("ignores a state older than the cached one (action reply racing an event)", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent, { states: [S("light.a", "on", "2026-01-01T10:00:00+00:00")] });

    cache.onStateChanged({ entity_id: "light.a", new_state: S("light.a", "off", "2026-01-01T09:59:00+00:00") });
    expect(cache.state("light.a")?.state).toBe("on");

    cache.applyState(S("light.a", "off", "2026-01-01T10:01:00+00:00"));
    expect(cache.state("light.a")?.state).toBe("off");
  });

  it("ignores state events before the cache is ready", async () => {
    const cache = await loadCache();
    const { send } = fakeSend();
    cache.start(send);
    cache.onStateChanged({ entity_id: "light.a", new_state: S("light.a", "on") });
    expect(cache.state("light.a")).toBeNull();
  });
});

describe("HaCache registry events", () => {
  it("re-requests only the changed list, debounced to one request per second", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent);
    const before = sent.length;

    const areaSub = sent.find((m) => m.event_type === "area_registry_updated")!;
    cache.onRegistryEvent(areaSub.id);
    cache.onRegistryEvent(areaSub.id);
    expect(sent).toHaveLength(before);

    vi.advanceTimersByTime(1_000);
    const extra = sent.slice(before);
    expect(extra.map((m) => m.type)).toEqual(["config/area_registry/list"]);
  });

  it("a registry update changes the derived index once the list arrives", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent, {
      areas: [{ area_id: "kitchen", name: "Cocina" }],
      entities: [{ entity_id: "light.a", area_id: "kitchen" }],
    });

    const areaSub = sent.find((m) => m.event_type === "area_registry_updated")!;
    cache.onRegistryEvent(areaSub.id);
    vi.advanceTimersByTime(1_000);
    answer(cache, sent, "config/area_registry/list", [{ area_id: "kitchen", name: "Cocina nueva" }]);
    expect(cache.areas().get("light.a")?.areaName).toBe("Cocina nueva");
  });

  it("ignores events for subscriptions it does not own", async () => {
    const cache = await loadCache();
    const { sent, send } = fakeSend();
    cache.start(send);
    loadAll(cache, sent);
    const before = sent.length;
    expect(cache.ownsSubscription(12345)).toBe(false);
    cache.onRegistryEvent(12345);
    vi.advanceTimersByTime(2_000);
    expect(sent).toHaveLength(before);
  });
});

describe("HaStates readers", () => {
  const KITCHEN = S("light.kitchen", "on");

  beforeEach(() => {
    process.env.HA_URL = "http://ha.test:8123";
    process.env.HA_TOKEN = "t";
  });

  async function loadAll2() {
    vi.resetModules();
    const fetchMock = vi.fn(async (url: string) =>
      new Response(JSON.stringify(String(url).endsWith("/api/states") ? [KITCHEN] : KITCHEN), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { haCache } = await import("@modules/ha/HaCache");
    const states = await import("@modules/ha/HaStates");
    return { haCache, states, fetchMock };
  }

  it("serves states and areas from the cache when ready, without calling HA", async () => {
    const { haCache, states, fetchMock } = await loadAll2();
    const { sent, send } = fakeSend();
    haCache.start(send);
    loadAll(haCache, sent, {
      states: [KITCHEN],
      areas: [{ area_id: "kitchen", name: "Cocina" }],
      devices: [{ id: "d1", name_by_user: "Luz" }],
      entities: [{ entity_id: "light.kitchen", area_id: "kitchen", device_id: "d1" }],
    });

    await expect(states.fetchStates()).resolves.toEqual([KITCHEN]);
    await expect(states.fetchState("light.kitchen")).resolves.toEqual(KITCHEN);
    await expect(states.fetchState("light.zzz")).resolves.toBeNull();
    await expect(states.fetchAreaIndex()).resolves.toEqual(
      new Map([["light.kitchen", { areaId: "kitchen", areaName: "Cocina" }]])
    );
    await expect(states.fetchAreaList()).resolves.toEqual([{ areaId: "kitchen", areaName: "Cocina" }]);
    await expect(states.fetchDeviceNameIndex()).resolves.toEqual(new Map([["light.kitchen", "Luz"]]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the REST path when the cache is not ready", async () => {
    const { haCache, states, fetchMock } = await loadAll2();
    expect(haCache.isReady()).toBe(false);

    await expect(states.fetchStates()).resolves.toEqual([KITCHEN]);
    await expect(states.fetchState("light.kitchen")).resolves.toEqual(KITCHEN);
    expect(fetchMock).toHaveBeenCalled();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/api/states"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/api/states/light.kitchen"))).toBe(true);
  });
});
