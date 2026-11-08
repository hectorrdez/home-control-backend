import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.fn();
const importLegacy = vi.fn();
const listen = vi.fn();
const savedFile = process.env.CALIBRATIONS_FILE;

beforeEach(() => {
  vi.resetModules();
  load.mockReset();
  importLegacy.mockReset();
  listen.mockReset();
});

afterEach(() => {
  if (savedFile === undefined) delete process.env.CALIBRATIONS_FILE;
  else process.env.CALIBRATIONS_FILE = savedFile;
  vi.doUnmock("dotenv/config");
  vi.doUnmock("../../src/app");
});

/** Loads the real entry point with its side-effecting collaborators replaced by spies. */
async function bootIndex() {
  vi.doMock("dotenv/config", () => ({}));
  vi.doMock("../../src/app", () => ({ default: { listen } }));
  vi.doMock("@utils/Logger", () => ({ default: { init: vi.fn(), write: vi.fn(), error: vi.fn() } }));
  vi.doMock("@modules/ha/HaClient", () => ({ warnIfHaMisconfigured: vi.fn(), haGet: vi.fn(), haPostText: vi.fn() }));
  vi.doMock("@modules/events/HaRecorder", () => ({ startHaRecorder: vi.fn() }));
  vi.doMock("@modules/stream/HaEvents", () => ({ haEvents: { keepAlive: vi.fn() } }));
  vi.doMock("../../src/db/pool", () => ({ pool: {} }));
  vi.doMock("../../src/db/connect", () => ({ connectDb: vi.fn(async () => undefined) }));
  vi.doMock("../../src/db/migrate", () => ({ migrate: vi.fn(async () => undefined) }));
  vi.doMock("../../src/db/health", () => ({ startDbPing: vi.fn() }));
  vi.doMock("@modules/aliases/AliasStore", () => ({ default: { load: vi.fn(), importLegacy: vi.fn() } }));
  vi.doMock("@modules/alert-rules/AlertRuleStore", () => ({ default: { load: vi.fn(), importLegacy: vi.fn() } }));
  vi.doMock("@modules/settings/SettingStore", () => ({ default: { load: vi.fn(async () => undefined) } }));
  vi.doMock("@modules/calibrations/CalibrationStore", () => ({ default: { load, importLegacy } }));
  await import("../../src/index");
  await vi.waitFor(() => expect(listen).toHaveBeenCalled());
}

describe("src/index.ts calibration wiring", () => {
  it("loads the default calibrations file and starts on port 3002 when CALIBRATIONS_FILE is unset", async () => {
    delete process.env.CALIBRATIONS_FILE;
    await bootIndex();
    expect(importLegacy).toHaveBeenCalledTimes(1);
    expect(importLegacy).toHaveBeenCalledWith("/data/calibrations.json");
    expect(listen).toHaveBeenCalledWith(3002, expect.any(Function));
  });

  it("loads the file named by CALIBRATIONS_FILE when it is set", async () => {
    process.env.CALIBRATIONS_FILE = "custom-dir/calibrations.json";
    await bootIndex();
    expect(importLegacy).toHaveBeenCalledWith("custom-dir/calibrations.json");
  });
});
