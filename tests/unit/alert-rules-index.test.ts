import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = vi.fn();
const listen = vi.fn();
const savedFile = process.env.ALERT_RULES_FILE;

beforeEach(() => {
  vi.resetModules();
  load.mockReset();
  listen.mockReset();
});

afterEach(() => {
  if (savedFile === undefined) delete process.env.ALERT_RULES_FILE;
  else process.env.ALERT_RULES_FILE = savedFile;
  vi.doUnmock("dotenv/config");
  vi.doUnmock("../../src/app");
});

/** Loads the real entry point with its side-effecting collaborators replaced by spies. */
async function bootIndex() {
  vi.doMock("dotenv/config", () => ({}));
  vi.doMock("../../src/app", () => ({ default: { listen } }));
  vi.doMock("@utils/Logger", () => ({ default: { init: vi.fn(), write: vi.fn(), error: vi.fn() } }));
  vi.doMock("@modules/ha/HaClient", () => ({ warnIfHaMisconfigured: vi.fn() }));
  vi.doMock("../../src/db/pool", () => ({ pool: {} }));
  vi.doMock("../../src/db/connect", () => ({ connectDb: vi.fn(async () => undefined) }));
  vi.doMock("../../src/db/migrate", () => ({ migrate: vi.fn(async () => undefined) }));
  vi.doMock("../../src/db/health", () => ({ startDbPing: vi.fn() }));
  vi.doMock("@modules/aliases/AliasStore", () => ({ default: { load: vi.fn() } }));
  vi.doMock("@modules/calibrations/CalibrationStore", () => ({ default: { load: vi.fn() } }));
  vi.doMock("@modules/alert-rules/AlertRuleStore", () => ({ default: { load } }));
  await import("../../src/index");
  await vi.waitFor(() => expect(listen).toHaveBeenCalled());
}

describe("src/index.ts alert rules wiring", () => {
  it("loads the default alert rules file when ALERT_RULES_FILE is unset", async () => {
    delete process.env.ALERT_RULES_FILE;
    await bootIndex();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("/data/alert-rules.json");
    expect(listen).toHaveBeenCalledWith(3002, expect.any(Function));
  });

  it("loads the file named by ALERT_RULES_FILE when it is set", async () => {
    process.env.ALERT_RULES_FILE = "custom-dir/alert-rules.json";
    await bootIndex();
    expect(load).toHaveBeenCalledWith("custom-dir/alert-rules.json");
  });
});
