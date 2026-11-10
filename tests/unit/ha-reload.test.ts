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

describe("POST /api/ha/reload (real app, HA never called)", () => {
  it("empty HA_RELOAD_DOMAINS -> 400 reload_disabled, and HA is not touched", async () => {
    process.env.API_TOKEN = "api-token-test";
    process.env.HA_RELOAD_DOMAINS = "";
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/ha/reload`, {
        method: "POST",
        headers: { Authorization: "Bearer api-token-test" },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("reload_disabled");
      expect(getMock).not.toHaveBeenCalled();
      expect(postMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
      delete process.env.API_TOKEN;
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

  it("within 30 s after release -> reload_cooldown (429) with retryAfterSeconds", () => {
    const gate = new ReloadGate();
    gate.acquire(0);
    gate.release(10_000);
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
    gate.release(10_000);
    expect(() => gate.acquire(40_000)).not.toThrow();
  });
});
