import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { haGet, haPostJson, parseTimeoutMs } from "@modules/ha/HaClient";
import { silenceConsole } from "./helpers";

const fetchMock = vi.fn();

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const KITCHEN = { entity_id: "light.kitchen", state: "on", attributes: {}, last_changed: "2026-01-01T10:00:00+00:00" };

async function load() {
  vi.resetModules();
  const [client, states, control, errors] = await Promise.all([
    import("@modules/ha/HaClient"),
    import("@modules/ha/HaStates"),
    import("@modules/entities/EntitiesControlService"),
    import("@modules/entities/EntityErrors"),
  ]);
  return { ...client, ...states, ...control, ...errors };
}

beforeEach(() => {
  silenceConsole();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "test-ha-token";
  delete process.env.HA_TIMEOUT_MS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseTimeoutMs", () => {
  it("defaults to 5000 when unset or blank", () => {
    expect(parseTimeoutMs(undefined)).toBe(5000);
    expect(parseTimeoutMs("  ")).toBe(5000);
  });

  it("accepts integers 1000..30000 and rejects everything else", () => {
    expect(parseTimeoutMs("2000")).toBe(2000);
    expect(parseTimeoutMs("1000")).toBe(1000);
    expect(parseTimeoutMs("30000")).toBe(30000);
    for (const bad of ["999", "30001", "1.5", "abc", "-5"]) expect(parseTimeoutMs(bad)).toBeNull();
  });
});

describe("haRequest retry policy", () => {
  it("retries a GET once after a network error, then succeeds", async () => {
    const { haGet: get } = await load();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(reply(200, [{ ok: 1 }]));
    await expect(get("/api/states")).resolves.toEqual([{ ok: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a GET once on 503, then fails with ha_unreachable when it stays down", async () => {
    const { haGet: get } = await load();
    fetchMock.mockResolvedValue(reply(503, {}));
    const err = await get("/api/states").catch((e) => e);
    expect(err.getErrorCode()).toBe("ha_unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a POST (service call), even on a network error", async () => {
    const { haPostJson: post } = await load();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const err = await post("/api/services/light/turn_on", { entity_id: "light.a" }).catch((e) => e);
    expect(err.getErrorCode()).toBe("ha_unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries a POST on 503", async () => {
    const { haPostJson: post } = await load();
    fetchMock.mockResolvedValue(reply(503, {}));
    const err = await post("/api/services/cover/open_cover", {}).catch((e) => e);
    expect(err.getErrorCode()).toBe("ha_unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 401 to unauthorized without retrying", async () => {
    const { haGet: get } = await load();
    fetchMock.mockResolvedValue(reply(401, {}));
    const err = await get("/api/").catch((e) => e);
    expect(err.getErrorCode()).toBe("ha_unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never echoes the token in thrown messages", async () => {
    const { haGet: get } = await load();
    fetchMock.mockResolvedValue(reply(500, {}));
    const err = await get("/api/").catch((e) => e);
    expect(err.getMessage()).toBe("Home Assistant responded 500");
    expect(String(err.getMessage())).not.toContain("test-ha-token");
  });
});

describe("fetchState", () => {
  it("reads one entity from /api/states/<entity_id>", async () => {
    const { fetchState } = await load();
    fetchMock.mockResolvedValue(reply(200, KITCHEN));
    await expect(fetchState("light.kitchen")).resolves.toEqual(KITCHEN);
    expect(fetchMock.mock.calls[0][0]).toBe("http://ha.test:8123/api/states/light.kitchen");
  });

  it("maps HA 404 to null, not an error", async () => {
    const { fetchState } = await load();
    fetchMock.mockResolvedValue(reply(404, { message: "not found" }));
    await expect(fetchState("light.gone")).resolves.toBeNull();
  });
});

describe("controlEntity uses the service reply", () => {
  /** Routes fake HA: the service reply, single-entity GETs, and the template endpoint. */
  function ha(serviceReply: unknown) {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = String(url).replace("http://ha.test:8123", "");
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/states/light.kitchen") return reply(200, KITCHEN);
      if (path.startsWith("/api/services/light/")) return reply(200, serviceReply);
      if (path === "/api/template") return new Response("", { status: 200 });
      return reply(404, {});
    });
    return calls;
  }

  it("normalizes the entity from the reply with no extra GET", async () => {
    const m = await load();
    const changed = { ...KITCHEN, state: "off" };
    const calls = ha([changed]);
    const out = await m.controlEntity("light.kitchen", { action: "turn_off" } as any);
    expect(out).toMatchObject({ entityId: "light.kitchen", state: "off" });
    expect(calls.filter((c) => c === "GET /api/states/light.kitchen")).toHaveLength(1);
    expect(calls.some((c) => c === "GET /api/states")).toBe(false);
  });

  it("falls back to one single-entity GET when the reply lacks the entity", async () => {
    const m = await load();
    const calls = ha([]);
    await m.controlEntity("light.kitchen", { action: "turn_off" } as any);
    expect(calls.filter((c) => c === "GET /api/states/light.kitchen")).toHaveLength(2);
  });

  it("service calls go out as POST and are not retried", async () => {
    const m = await load();
    const calls = ha([]);
    await m.controlEntity("light.kitchen", { action: "turn_on" } as any);
    expect(calls.filter((c) => c.startsWith("POST /api/services/"))).toHaveLength(1);
  });

  it("an unknown entity still answers 404 through the pre-check", async () => {
    const m = await load();
    fetchMock.mockResolvedValue(reply(404, {}));
    await expect(m.controlEntity("light.nope", { action: "turn_on" } as any)).rejects.toBeInstanceOf(
      m.EntityNotFoundError
    );
  });
});

describe("haGet / haPostJson exports", () => {
  it("haGet and haPostJson keep working on the module boundary", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { a: 1 })).mockResolvedValueOnce(reply(200, [{ b: 2 }]));
    await expect(haGet("/api/")).resolves.toEqual({ a: 1 });
    await expect(haPostJson("/api/services/x/y", {})).resolves.toEqual([{ b: 2 }]);
  });
});
