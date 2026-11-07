import { beforeEach, describe, expect, it } from "vitest";
import { CalibrationStore } from "@modules/calibrations/CalibrationStore";
import { createFakeDocumentDb, FakeDocumentDb } from "./fake-documents-db";
import { silenceConsole } from "./helpers";

let db: FakeDocumentDb;

const valid = (over: Record<string, unknown> = {}) => ({
  openMs: 15000,
  closeMs: 14000,
  position: null,
  calibratedAt: "2026-11-07T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  db = createFakeDocumentDb();
});

describe("CalibrationStore load", () => {
  it("lists valid rows sorted by entity id", async () => {
    db.seed("calibrations", { "cover.b": valid(), "cover.a": valid({ openMs: 9000 }) });
    const store = new CalibrationStore(db);
    await store.load();
    expect(store.list().map((e) => e.entityId)).toEqual(["cover.a", "cover.b"]);
    expect(store.get("cover.a")?.openMs).toBe(9000);
  });

  it("skips invalid rows and logs how many were ignored", async () => {
    const con = silenceConsole();
    db.seed("calibrations", {
      "cover.ok": valid(),
      "light.wrong_domain": valid(),
      "COVER.Bad": valid(),
      "cover.short": valid({ openMs: 100 }),
      "cover.frac": valid({ closeMs: 1.5 }),
      "cover.pos": valid({ position: 150 }),
      "cover.nots": valid({ calibratedAt: 5 }),
      "cover.str": "nope",
    });
    const store = new CalibrationStore(db);
    await store.load();
    expect(store.list().map((e) => e.entityId)).toEqual(["cover.ok"]);
    expect(con.log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("ignored 7 invalid calibration entries");
  });
});
