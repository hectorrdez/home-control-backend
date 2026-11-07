import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silenceConsole } from "./helpers";

/**
 * Loads every module under test fresh. HaStates keeps a 30s module-level cache and
 * the error classes must come from the same module graph as the code that throws them.
 */
async function load() {
  vi.resetModules();
  const [svc, areas, entities, control, errors, haErrors] = await Promise.all([
    import("@modules/ha/HaService"),
    import("@modules/areas/AreasService"),
    import("@modules/entities/EntitiesService"),
    import("@modules/entities/EntitiesControlService"),
    import("@modules/entities/EntityErrors"),
    import("@modules/ha/HaErrors"),
  ]);
  return {
    haStatus: svc.haStatus,
    listAreas: areas.listAreas,
    listEntities: entities.listEntities,
    controlEntity: control.controlEntity,
    DomainNotAllowedError: errors.DomainNotAllowedError,
    EntityNotFoundError: errors.EntityNotFoundError,
    InvalidActionError: errors.InvalidActionError,
    InvalidEntityIdError: errors.InvalidEntityIdError,
    HaUnauthorizedError: haErrors.HaUnauthorizedError,
  };
}

/** Routes HA REST paths to canned replies. Unknown paths fail the test loudly. */
function haRouter(routes: Record<string, (init?: RequestInit) => unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const key = Object.keys(routes).find((k) => path === k || path.startsWith(k));
    if (!key) throw new Error(`unexpected HA call: ${url}`);
    const out = routes[key](init);
    return typeof out === "string"
      ? new Response(out, { status: 200 })
      : new Response(JSON.stringify(out), { status: 200 });
  });
}

const STATES = [
  {
    entity_id: "light.kitchen",
    state: "on",
    last_changed: "2026-01-01T00:00:00Z",
    attributes: { friendly_name: "Luz cocina", brightness: 100 },
  },
  {
    entity_id: "switch.fan",
    state: "off",
    last_changed: "2026-01-01T00:00:00Z",
    attributes: { friendly_name: "Ventilador" },
  },
  {
    entity_id: "light.attic",
    state: "off",
    last_changed: "2026-01-01T00:00:00Z",
    attributes: {},
  },
];

// Template replies: entity|area|areaName lines (index) and area|areaName lines (area list).
const INDEX_TEXT = "light.kitchen|kitchen|Cocina\nswitch.fan|kitchen|Cocina\n";
const AREA_LIST_TEXT = "kitchen|Cocina\nbedroom|Dormitorio\n";

/** Index template contains area_entities; the area list template does not. */
const templateReply = (indexText: string) => (init?: RequestInit) =>
  JSON.parse(String(init?.body)).template.includes("area_entities") ? indexText : AREA_LIST_TEXT;

beforeEach(() => {
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "t";
  silenceConsole();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("haStatus", () => {
  it("reports online with the HA message and version", async () => {
    const m = await load();
    vi.stubGlobal(
      "fetch",
      haRouter({
        "/api/config": () => ({ version: "2026.1.0" }),
        "/api/": () => ({ message: "API running." }),
      })
    );
    await expect(m.haStatus()).resolves.toEqual([{ online: true, message: "API running.", version: "2026.1.0" }]);
  });

  it("returns nulls when HA omits message and version", async () => {
    const m = await load();
    vi.stubGlobal("fetch", haRouter({ "/api/config": () => ({}), "/api/": () => ({}) }));
    await expect(m.haStatus()).resolves.toEqual([{ online: true, message: null, version: null }]);
  });

  it("propagates a token rejection from HA", async () => {
    const m = await load();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(m.haStatus()).rejects.toBeInstanceOf(m.HaUnauthorizedError);
  });
});

describe("listEntities", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", haRouter({ "/api/states": () => STATES, "/api/template": templateReply(INDEX_TEXT) }));
  });

  it("returns every entity normalized and sorted by name", async () => {
    const m = await load();
    const all = await m.listEntities({});
    expect(all.map((e) => e.entityId)).toEqual(["light.attic", "light.kitchen", "switch.fan"]);
    expect(all[1]).toMatchObject({ name: "Luz cocina", area: "kitchen", areaName: "Cocina" });
  });

  it("filters by domain and by area", async () => {
    const m = await load();
    expect((await m.listEntities({ domain: "light" })).map((e) => e.entityId)).toEqual([
      "light.attic",
      "light.kitchen",
    ]);
    expect((await m.listEntities({ area: "kitchen" })).map((e) => e.entityId)).toEqual([
      "light.kitchen",
      "switch.fan",
    ]);
    expect(await m.listEntities({ domain: "lock" })).toEqual([]);
  });
});

describe("listAreas", () => {
  it("groups entities under their HA areas, keeps empty areas, and puts unassigned last", async () => {
    const m = await load();
    vi.stubGlobal("fetch", haRouter({ "/api/states": () => STATES, "/api/template": templateReply(INDEX_TEXT) }));
    const groups = await m.listAreas();
    expect(groups.map((g) => g.name)).toEqual(["Cocina", "Dormitorio", "Unassigned"]);
    expect(groups[0].entities.map((e) => e.entityId)).toEqual(["light.kitchen", "switch.fan"]);
    expect(groups[1].entities).toEqual([]);
    expect(groups[2]).toMatchObject({
      areaId: null,
      entities: [expect.objectContaining({ entityId: "light.attic" })],
    });
  });

  it("creates a group for an area that HA reports on an entity but not in the area list", async () => {
    const m = await load();
    vi.stubGlobal(
      "fetch",
      haRouter({
        "/api/states": () => STATES.slice(0, 1),
        "/api/template": templateReply("light.kitchen|garage|Garaje\n"),
      })
    );
    const groups = await m.listAreas();
    expect(groups.find((g) => g.areaId === "garage")?.entities).toHaveLength(1);
  });
});

describe("controlEntity", () => {
  const body = (b: unknown) => b as any;

  it("calls the HA service for an allowed domain and returns the re-read state", async () => {
    const m = await load();
    let reads = 0;
    const fetchMock = haRouter({
      "/api/services/light/turn_on": () => [],
      "/api/states": () => {
        reads++;
        return reads === 1
          ? STATES
          : [{ ...STATES[0], state: "on", attributes: { friendly_name: "Luz cocina", brightness: 200 } }];
      },
      "/api/template": templateReply(INDEX_TEXT),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await m.controlEntity("light.kitchen", body({ action: "turn_on", params: { brightness: 200 } }));
    expect(out).toMatchObject({ entityId: "light.kitchen", state: "on", attributes: { brightness: 200 } });

    const serviceCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/services/"));
    expect(serviceCall).toBeDefined();
    expect(JSON.parse(String(serviceCall![1]?.body))).toEqual({ entity_id: "light.kitchen", brightness: 200 });
  });

  it("rejects an invalid entity id before calling HA", async () => {
    const m = await load();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(m.controlEntity("Light.X", body({ action: "toggle" }))).rejects.toBeInstanceOf(
      m.InvalidEntityIdError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects domains outside the allowlist with 403", async () => {
    const m = await load();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = await m.controlEntity("sensor.front", body({ action: "turn_on" })).catch((e) => e);
    expect(err).toBeInstanceOf(m.DomainNotAllowedError);
    expect(err.getCode()).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the lock service for a lock entity", async () => {
    const m = await load();
    const lockStates = [{ ...STATES[0], entity_id: "lock.front", state: "locked" }];
    let reads = 0;
    const fetchMock = haRouter({
      "/api/services/lock/unlock": () => [],
      "/api/states": () => {
        reads++;
        return reads === 1 ? lockStates : [{ ...lockStates[0], state: "unlocked" }];
      },
      "/api/template": templateReply(INDEX_TEXT),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await m.controlEntity("lock.front", body({ action: "unlock" }));
    expect(out).toMatchObject({ entityId: "lock.front", state: "unlocked" });
    const serviceCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/services/"));
    expect(JSON.parse(String(serviceCall![1]?.body))).toEqual({ entity_id: "lock.front" });
  });

  it("rejects an action that the entity's domain does not support with 400", async () => {
    const m = await load();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const err = await m.controlEntity("lock.front", body({ action: "toggle" })).catch((e) => e);
    expect(err).toBeInstanceOf(m.InvalidActionError);
    expect(err.getCode()).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the entity does not exist in HA", async () => {
    const m = await load();
    vi.stubGlobal("fetch", haRouter({ "/api/states": () => [] }));
    const err = await m.controlEntity("light.ghost", body({ action: "turn_on" })).catch((e) => e);
    expect(err).toBeInstanceOf(m.EntityNotFoundError);
    expect(err.getCode()).toBe(404);
  });
});
