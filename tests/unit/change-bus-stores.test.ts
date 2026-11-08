import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appEvents, AppEvent } from "@shared/events/AppEvents";
import { AliasStore } from "@modules/aliases/AliasStore";
import { CalibrationStore } from "@modules/calibrations/CalibrationStore";
import { AlertRuleStore } from "@modules/alert-rules/AlertRuleStore";
import { createFakeDocumentDb, FakeDocumentDb } from "./fake-documents-db";
import { silenceConsole } from "./helpers";

const RULE_ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const record = { openMs: 15000, closeMs: 14000, position: null, calibratedAt: "2026-01-01T00:00:00.000Z" };
const rule = { entityId: "light.a", trigger: { type: "connects" as const }, level: "high" as const };

let db: FakeDocumentDb;
let seen: AppEvent[];
let off: () => void;

beforeEach(() => {
  silenceConsole();
  db = createFakeDocumentDb();
  seen = [];
  off = appEvents.subscribe((evt) => seen.push(evt));
});

afterEach(() => {
  off();
  vi.restoreAllMocks();
});

describe("AliasStore change events", () => {
  it("emits once per successful mutate with resource, changed keys and by", async () => {
    const store = new AliasStore(db);
    await store.load();
    await store.mutate((draft) => {
      draft.set("light.a", "Luz");
      return true;
    }, { by: "client-1" });
    expect(seen).toEqual([{ type: "resource_changed", resource: "aliases", keys: ["light.a"], by: "client-1" }]);
  });

  it("emits by: null when no writer id is given", async () => {
    const store = new AliasStore(db);
    await store.load();
    await store.mutate((draft) => {
      draft.set("light.a", "Luz");
      return true;
    });
    expect(seen[0].by).toBeNull();
  });

  it("emits nothing when the change reports no difference", async () => {
    const store = new AliasStore(db);
    await store.load();
    await store.mutate(() => false);
    expect(seen).toEqual([]);
  });

  it("emits nothing when the write fails", async () => {
    const store = new AliasStore(db);
    await store.load();
    db.failNext(/INSERT INTO documents/);
    await expect(
      store.mutate((draft) => {
        draft.set("light.a", "Luz");
        return true;
      })
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe("CalibrationStore change events", () => {
  it("emits the calibration resource with the cover key", async () => {
    const store = new CalibrationStore(db);
    await store.load();
    await store.mutate((draft) => {
      draft.set("cover.kitchen", record);
      return true;
    }, { by: "client-2" });
    expect(seen).toEqual([
      { type: "resource_changed", resource: "calibrations", keys: ["cover.kitchen"], by: "client-2" },
    ]);
  });

  it("emits a removed key on delete", async () => {
    db.seed("calibrations", { "cover.kitchen": record });
    const store = new CalibrationStore(db);
    await store.load();
    await store.mutate((draft) => draft.delete("cover.kitchen"));
    expect(seen[0]).toMatchObject({ resource: "calibrations", keys: ["cover.kitchen"], by: null });
  });

  it("emits nothing when the change reports no difference", async () => {
    const store = new CalibrationStore(db);
    await store.load();
    await store.mutate(() => false);
    expect(seen).toEqual([]);
  });

  it("emits nothing when the write fails", async () => {
    const store = new CalibrationStore(db);
    await store.load();
    db.failNext(/INSERT INTO documents/);
    await expect(
      store.mutate((draft) => {
        draft.set("cover.kitchen", record);
        return true;
      })
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe("AlertRuleStore change events", () => {
  it("emits the alert_rules resource with the rule id", async () => {
    const store = new AlertRuleStore(db);
    await store.load();
    await store.mutate((draft) => {
      draft.set(RULE_ID, rule);
      return true;
    }, { by: "client-3" });
    expect(seen).toEqual([{ type: "resource_changed", resource: "alert_rules", keys: [RULE_ID], by: "client-3" }]);
  });

  it("emits nothing when the change reports no difference", async () => {
    const store = new AlertRuleStore(db);
    await store.load();
    await store.mutate(() => false);
    expect(seen).toEqual([]);
  });

  it("emits nothing when the write fails", async () => {
    const store = new AlertRuleStore(db);
    await store.load();
    db.failNext(/INSERT INTO documents/);
    await expect(
      store.mutate((draft) => {
        draft.set(RULE_ID, rule);
        return true;
      })
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
