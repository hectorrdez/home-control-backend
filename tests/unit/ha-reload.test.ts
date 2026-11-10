import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApiError from "@errors/ApiError";
import { haGet, haPostJson } from "@modules/ha/HaClient";
import { HaUnauthorizedError, HaUnreachableError } from "@modules/ha/HaErrors";
import { haCache } from "@modules/ha/HaCache";
import {
  ReloadGate,
  configuredReloadDomains,
  parseReloadDomains,
  reloadHaIntegrations,
  settleEntityCount,
} from "@modules/ha/HaReloadService";
import { ReloadCooldownError, ReloadDisabledError, ReloadInProgressError } from "@modules/ha/HaReloadErrors";
import { appEvents, AppEvent } from "@shared/events/AppEvents";
import { silenceConsole, startApp } from "./helpers";

vi.mock("@modules/ha/HaClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modules/ha/HaClient")>()),
  haGet: vi.fn(),
  haPostJson: vi.fn(),
}));

const getMock = vi.mocked(haGet);
const postMock = vi.mocked(haPostJson);

const TUYA_A = { entry_id: "a1", domain: "tuya", title: "Smart Life A", disabled_by: null };
const TUYA_B = { entry_id: "b2", domain: "tuya", title: "Smart Life B", disabled_by: null };
const LOCAL = { entry_id: "c3", domain: "localtuya", title: "Local", disabled_by: null };
const HUE = { entry_id: "d4", domain: "hue", title: "Hue", disabled_by: null };
const DISABLED = { entry_id: "e5", domain: "tuya", title: "Off", disabled_by: "user" };

/** Sleep stub that runs a callback before each step, so the entity count can change "during" the settle. */
function sleepWith(onStep?: (step: number) => void) {
  let step = 0;
  return vi.fn(async () => {
    step++;
    onStep?.(step);
  });
}

let states: number;

beforeEach(() => {
  silenceConsole();
  getMock.mockReset();
  postMock.mockReset();
  postMock.mockResolvedValue({ require_restart: false });
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "secret-token-xyz";
  delete process.env.HA_RELOAD_DOMAINS;
  states = 3;
  vi.spyOn(haCache, "isReady").mockImplementation(() => true);
  vi.spyOn(haCache, "allStates").mockImplementation(() => Array.from({ length: states }, (_, i) => ({ entity_id: `x.${i}` })) as never);
  vi.spyOn(haCache, "refreshRegistries").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("allow-list parsing", () => {
  it("defaults to tuya,localtuya when unset", () => {
    expect(configuredReloadDomains()).toEqual(["tuya", "localtuya"]);
  });

  it("trims, lowercases and de-duplicates", () => {
    expect(parseReloadDomains(" Tuya , localtuya,,TUYA ")).toEqual(["tuya", "localtuya"]);
  });

  it("empty value is reload_disabled (400)", () => {
    process.env.HA_RELOAD_DOMAINS = "  ";
    expect(() => configuredReloadDomains()).toThrow(ReloadDisabledError);
    try {
      configuredReloadDomains();
    } catch (err) {
      expect((err as ApiError).getCode()).toBe(400);
      expect((err as ApiError).getErrorCode()).toBe("reload_disabled");
    }
  });
});

describe("reloadHaIntegrations", () => {
  it("only reloads allow-listed domains and skips disabled entries", async () => {
    getMock.mockResolvedValueOnce([TUYA_A, HUE, LOCAL, DISABLED]);
    const out = await reloadHaIntegrations(["tuya", "localtuya"], null, sleepWith());
    expect(out.data.map((d) => d.entryId)).toEqual(["a1", "c3"]);
    expect(postMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/config/config_entries/entry/a1/reload",
      "/api/config/config_entries/entry/c3/reload",
    ]);
  });

  it("reloads one entry after another, never in parallel, in list order", async () => {
    getMock.mockResolvedValueOnce([TUYA_A, TUYA_B, LOCAL]);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    postMock.mockImplementation(async (path: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(path);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {};
    });
    await reloadHaIntegrations(["tuya", "localtuya"], null, sleepWith());
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([
      "/api/config/config_entries/entry/a1/reload",
      "/api/config/config_entries/entry/b2/reload",
      "/api/config/config_entries/entry/c3/reload",
    ]);
  });

  it("a failing entry does not stop the others and carries a short error code", async () => {
    getMock.mockResolvedValueOnce([TUYA_A, TUYA_B]);
    postMock
      .mockRejectedValueOnce(new HaUnreachableError())
      .mockResolvedValueOnce({ require_restart: false });
    const out = await reloadHaIntegrations(["tuya"], null, sleepWith());
    expect(out.data).toEqual([
      { entryId: "a1", domain: "tuya", title: "Smart Life A", ok: false, error: "ha_unreachable" },
      { entryId: "b2", domain: "tuya", title: "Smart Life B", ok: true },
    ]);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("no matching entries -> empty data, counts unchanged, no reload, no refresh, no SSE", async () => {
    getMock.mockResolvedValueOnce([HUE]);
    const seen: AppEvent[] = [];
    const off = appEvents.subscribe((e) => seen.push(e));
    const out = await reloadHaIntegrations(["tuya"], null, sleepWith());
    off();
    expect(out).toEqual({ data: [], entities: { before: 3, after: 3 } });
    expect(postMock).not.toHaveBeenCalled();
    expect(haCache.refreshRegistries).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("reports before/after entity counts from the cache, stopping once stable for 2 polls", async () => {
    getMock.mockResolvedValueOnce([TUYA_A]);
    const sleep = sleepWith((step) => {
      if (step === 1) states = 5; // new device appears
    });
    const out = await reloadHaIntegrations(["tuya"], null, sleep);
    expect(out.entities).toEqual({ before: 3, after: 5 });
    // poll 1 changes (5), poll 2 same (1 stable), poll 3 same (2 stable) -> stop after 3 polls
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("counts are null while the cache is not ready", async () => {
    vi.mocked(haCache.isReady).mockReturnValue(false);
    getMock.mockResolvedValueOnce([TUYA_A]);
    const out = await reloadHaIntegrations(["tuya"], null, sleepWith());
    expect(out.entities).toEqual({ before: null, after: null });
    expect(haCache.refreshRegistries).toHaveBeenCalledTimes(1);
  });

  it("refreshes the registries and emits entities and areas resource_changed frames", async () => {
    getMock.mockResolvedValueOnce([TUYA_A]);
    const seen: AppEvent[] = [];
    const off = appEvents.subscribe((e) => seen.push(e));
    await reloadHaIntegrations(["tuya"], "11111111-2222-3333-4444-555555555555", sleepWith());
    off();
    expect(haCache.refreshRegistries).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      { type: "resource_changed", resource: "entities", keys: [], by: "11111111-2222-3333-4444-555555555555" },
      { type: "resource_changed", resource: "areas", keys: [], by: "11111111-2222-3333-4444-555555555555" },
    ]);
  });

  it("maps an HA unreachable list to 502 ha_unreachable", async () => {
    getMock.mockRejectedValueOnce(new HaUnreachableError());
    const err = await reloadHaIntegrations(["tuya"], null, sleepWith()).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.getCode()).toBe(502);
    expect(err.getErrorCode()).toBe("ha_unreachable");
  });

  it("maps an HA auth failure to 502 ha_unauthorized", async () => {
    getMock.mockRejectedValueOnce(new HaUnauthorizedError());
    const err = await reloadHaIntegrations(["tuya"], null, sleepWith()).catch((e) => e as ApiError);
    expect(err.getCode()).toBe(502);
    expect(err.getErrorCode()).toBe("ha_unauthorized");
  });

  it("never puts the HA token in errors", async () => {
    getMock.mockRejectedValueOnce(new HaUnreachableError());
    const err = await reloadHaIntegrations(["tuya"], null, sleepWith()).catch((e) => e as ApiError);
    expect(JSON.stringify(err.getMessage())).not.toContain("secret-token-xyz");
  });
});

describe("settleEntityCount", () => {
  it("returns null when the cache is not ready", async () => {
    vi.mocked(haCache.isReady).mockReturnValue(false);
    await expect(settleEntityCount(sleepWith())).resolves.toBeNull();
  });

  it("gives up after about 8 s (16 polls of 500 ms) if the count keeps moving", async () => {
    const sleep = vi.fn(async () => {
      states++;
    });
    await settleEntityCount(sleep);
    expect(sleep).toHaveBeenCalledTimes(16);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});

describe("POST /api/ha/reload (real app)", () => {
  const TOKEN = "api-token-test";

  /** Fresh module graph per startApp: take the HA client mock the app is using. */
  async function haClient() {
    const mod = await import("@modules/ha/HaClient");
    return { get: vi.mocked(mod.haGet), post: vi.mocked(mod.haPostJson) };
  }

  /** Error from the same module graph as the app (startApp resets it, so the top-level class would not match instanceof). */
  async function unreachable() {
    const errors = await import("@modules/ha/HaErrors");
    return new errors.HaUnreachableError();
  }

  function reloadCall(base: string) {
    return fetch(`${base}/ha/reload`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  }

  beforeEach(() => {
    process.env.API_TOKEN = TOKEN;
    delete process.env.HA_RELOAD_DOMAINS;
  });

  afterEach(() => {
    delete process.env.API_TOKEN;
    delete process.env.HA_RELOAD_DOMAINS;
  });

  it("HA unreachable on the list (502) does not start the cooldown, and the lock is released", async () => {
    const app = await startApp();
    try {
      const ha = await haClient();
      ha.get.mockRejectedValue(await unreachable());
      const first = await reloadCall(app.base);
      expect(first.status).toBe(502);
      expect((await first.json()).error).toBe("ha_unreachable");
      const second = await reloadCall(app.base);
      expect(second.status).toBe(502); // not 429 reload_cooldown, and not 409 reload_in_progress
      expect((await second.json()).error).toBe("ha_unreachable");
    } finally {
      await app.close();
    }
  });

  it("empty allow-list (400) does not start the cooldown", async () => {
    process.env.HA_RELOAD_DOMAINS = "";
    const app = await startApp();
    try {
      const ha = await haClient();
      const first = await reloadCall(app.base);
      expect(first.status).toBe(400);
      expect((await first.json()).error).toBe("reload_disabled");
      expect(ha.get).not.toHaveBeenCalled();
      expect(ha.post).not.toHaveBeenCalled();
      delete process.env.HA_RELOAD_DOMAINS;
      ha.get.mockResolvedValue([]);
      const second = await reloadCall(app.base);
      expect(second.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("no matching entries (200, data []) does not start the cooldown", async () => {
    const app = await startApp();
    try {
      const ha = await haClient();
      ha.get.mockResolvedValue([{ entry_id: "d4", domain: "hue", disabled_by: null }]);
      for (let i = 0; i < 2; i++) {
        const res = await reloadCall(app.base);
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual([]);
      }
      expect(ha.post).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("cooldown still applies after a real reload attempt, even if that entry failed", async () => {
    const app = await startApp();
    try {
      const ha = await haClient();
      ha.get.mockResolvedValue([{ entry_id: "a1", domain: "tuya", title: "A", disabled_by: null }]);
      ha.post.mockRejectedValue(await unreachable());
      const first = await reloadCall(app.base);
      expect(first.status).toBe(200);
      const body = await first.json();
      expect(body.data).toEqual([{ entryId: "a1", domain: "tuya", title: "A", ok: false, error: "ha_unreachable" }]);
      const second = await reloadCall(app.base);
      expect(second.status).toBe(429);
      const limited = await second.json();
      expect(limited.error).toBe("reload_cooldown");
      expect(limited.meta.retryAfterSeconds).toBeGreaterThan(0);
      expect(second.headers.get("retry-after")).toBe(String(limited.meta.retryAfterSeconds));
    } finally {
      await app.close();
    }
  });

  it("without the API key -> 401 (gate runs before the reload)", async () => {
    process.env.API_TOKEN = "api-token-test";
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/ha/reload`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(getMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
      delete process.env.API_TOKEN;
    }
  });
});

describe("ReloadGate", () => {
  it("second acquire while running -> reload_in_progress (409)", () => {
    const gate = new ReloadGate();
    gate.acquire(0);
    expect(() => gate.acquire(1)).toThrow(ReloadInProgressError);
  });

  it("within 30 s after a real attempt -> reload_cooldown (429) with retryAfterSeconds", () => {
    const gate = new ReloadGate();
    gate.acquire(0);
    gate.release(10_000, true);
    try {
      gate.acquire(11_000);
      throw new Error("expected cooldown");
    } catch (err) {
      expect(err).toBeInstanceOf(ReloadCooldownError);
      expect((err as ReloadCooldownError).retryAfterSeconds).toBe(29);
      expect((err as ReloadCooldownError).getCode()).toBe(429);
    }
  });

  it("allows a reload again once the cooldown has passed", () => {
    const gate = new ReloadGate();
    gate.acquire(0);
    gate.release(10_000, true);
    expect(() => gate.acquire(40_000)).not.toThrow();
  });

  it("a release without a reload attempt does not start the cooldown", () => {
    const gate = new ReloadGate();
    gate.acquire(0);
    gate.release(10_000, false);
    expect(() => gate.acquire(10_001)).not.toThrow();
  });

  it("the lock is freed on release even when nothing was attempted", () => {
    const gate = new ReloadGate();
    gate.acquire(0);
    gate.release(1, false);
    expect(() => gate.acquire(2)).not.toThrow();
  });
});
