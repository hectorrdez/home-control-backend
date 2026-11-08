import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HaState } from "@modules/ha/HaStates";

const fetchMock = vi.fn();

function state(partial: Partial<HaState> & { attributes?: Record<string, unknown> }): HaState {
  return {
    entity_id: "light.kitchen",
    state: "on",
    last_changed: "2026-01-01T10:00:00+00:00",
    attributes: {},
    ...partial,
  } as HaState;
}

/** HaStates keeps a 30s module-level cache, so every test loads a fresh module. */
async function loadStates() {
  vi.resetModules();
  return import("@modules/ha/HaStates");
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "t";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeEntity", () => {
  it("derives domain, friendly name and area from the state and index", async () => {
    const { normalizeEntity } = await loadStates();
    const index = new Map([["light.kitchen", { areaId: "kitchen", areaName: "Cocina" }]]);
    const out = normalizeEntity(
      state({ attributes: { friendly_name: "Luz cocina", brightness: 120 } }),
      index
    );
    expect(out).toEqual({
      entityId: "light.kitchen",
      domain: "light",
      name: "Luz cocina",
      state: "on",
      attributes: { friendly_name: "Luz cocina", brightness: 120 },
      area: "kitchen",
      areaName: "Cocina",
      deviceName: null,
      lastChanged: "2026-01-01T10:00:00+00:00",
    });
  });

  it("falls back to the entity id when friendly_name is missing or not a string", async () => {
    const { normalizeEntity } = await loadStates();
    expect(normalizeEntity(state({ attributes: {} }), new Map()).name).toBe("light.kitchen");
    expect(normalizeEntity(state({ attributes: { friendly_name: 42 } }), new Map()).name).toBe("light.kitchen");
  });

  it("drops attributes that are not on the safe list (no HA internals or context)", async () => {
    const { normalizeEntity } = await loadStates();
    const out = normalizeEntity(
      state({
        attributes: {
          friendly_name: "x",
          supported_features: 44,
          context: { id: "secret" },
          hvac_mode: "heat",
          media_title: "song",
        },
      }),
      new Map()
    );
    expect(out.attributes).toEqual({ friendly_name: "x", hvac_mode: "heat", media_title: "song" });
  });

  it("returns null area fields when the entity has no area", async () => {
    const { normalizeEntity } = await loadStates();
    const out = normalizeEntity(state({ entity_id: "switch.fan" }), new Map());
    expect(out.domain).toBe("switch");
    expect(out.area).toBeNull();
    expect(out.areaName).toBeNull();
  });

  it("tolerates a state object with no attributes at all", async () => {
    const { normalizeEntity } = await loadStates();
    const raw = { entity_id: "sensor.t", state: "21", last_changed: "x" } as unknown as HaState;
    const out = normalizeEntity(raw, new Map());
    expect(out.attributes).toEqual({});
    expect(out.name).toBe("sensor.t");
  });
});

describe("fetchStates / fetchState", () => {
  it("reads /api/states and finds one entity by id", async () => {
    const { fetchStates, fetchState } = await loadStates();
    const all = [state({ entity_id: "light.a" }), state({ entity_id: "light.b" })];
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(all), { status: 200 }));

    await expect(fetchStates()).resolves.toEqual(all);
    expect(fetchMock.mock.calls[0][0]).toBe("http://ha.test:8123/api/states");
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/light.b") ? new Response(JSON.stringify(all[1]), { status: 200 }) : new Response("", { status: 404 })
    );
    await expect(fetchState("light.b")).resolves.toEqual(all[1]);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("http://ha.test:8123/api/states/light.b");
    await expect(fetchState("light.zzz")).resolves.toBeNull();
  });
});

describe("fetchAreaIndex", () => {
  it("parses the template output into entity -> area, defaulting the area name to the id", async () => {
    const { fetchAreaIndex } = await loadStates();
    fetchMock.mockResolvedValue(
      new Response("light.a|kitchen|Cocina\nswitch.b|garage|\n\nbad-line\n", { status: 200 })
    );
    const index = await fetchAreaIndex();
    expect(index.get("light.a")).toEqual({ areaId: "kitchen", areaName: "Cocina" });
    expect(index.get("switch.b")).toEqual({ areaId: "garage", areaName: "garage" });
    expect(index.has("bad-line")).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toBe("http://ha.test:8123/api/template");
  });

  it("serves a second call from cache within 30s, then refetches", async () => {
    const { fetchAreaIndex } = await loadStates();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fetchMock.mockImplementation(async () => new Response("light.a|k|K\n", { status: 200 }));

    await fetchAreaIndex();
    now.mockReturnValue(1_000_000 + 29_000);
    await fetchAreaIndex();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 31_000);
    await fetchAreaIndex();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates HA errors without caching a failure", async () => {
    const { fetchAreaIndex } = await loadStates();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(fetchAreaIndex()).rejects.toThrow("Home Assistant responded 500");
    fetchMock.mockResolvedValueOnce(new Response("light.a|k|K\n", { status: 200 }));
    await expect(fetchAreaIndex()).resolves.toBeInstanceOf(Map);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("fetchAreaList", () => {
  it("returns every area, including areas with no entities", async () => {
    const { fetchAreaList } = await loadStates();
    fetchMock.mockResolvedValue(new Response("kitchen|Cocina\nattic|\n\n", { status: 200 }));
    await expect(fetchAreaList()).resolves.toEqual([
      { areaId: "kitchen", areaName: "Cocina" },
      { areaId: "attic", areaName: "attic" },
    ]);
  });

  it("caches the list for 30s", async () => {
    const { fetchAreaList } = await loadStates();
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
    fetchMock.mockImplementation(async () => new Response("kitchen|Cocina\n", { status: 200 }));
    await fetchAreaList();
    now.mockReturnValue(20_000);
    await fetchAreaList();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(40_000);
    await fetchAreaList();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
