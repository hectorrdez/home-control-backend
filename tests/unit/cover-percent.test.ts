import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import calibrationStore from "@modules/calibrations/CalibrationStore";
import { InvalidEntityIdError, DomainNotAllowedError, EntityNotFoundError, InvalidParamsError } from "@modules/entities/EntityErrors";
import { NotCalibratedError, PositionUnknownError } from "@modules/covers/CoverMoveErrors";
import { parsePercent, setCoverPercent } from "@modules/covers/CoverPercentService";
import { controlEntity } from "@modules/entities/EntitiesControlService";
import { normalizeEntity, HaState } from "@modules/ha/HaStates";
import { haGet, haGetOptional, haPostJson, haPostText } from "@modules/ha/HaClient";
import EntitiesController from "@modules/entities/EntitiesController";
import { fakeRes, silenceConsole } from "./helpers";
const docs = await vi.hoisted(async () => (await import("./fake-documents-db")).createFakeDocumentDb());
vi.mock("pg", () => ({ Pool: class { constructor() { return Object.assign(docs, { on: () => undefined }); } } }));

vi.mock("@modules/ha/HaClient", () => ({
  haGet: vi.fn(),
  haGetOptional: vi.fn(),
  haPostJson: vi.fn(),
  haPostText: vi.fn(),
  warnIfHaMisconfigured: vi.fn(),
}));

const ENTITY = "cover.bruno_calibration_test";
const OPEN_MS = 10000;
const CLOSE_MS = 20000;
const COVER_STATE: HaState = {
  entity_id: ENTITY,
  state: "closed",
  attributes: { friendly_name: "Kitchen cover" },
  last_changed: "2026-01-01T00:00:00Z",
};

let dir: string;
const services = () =>
  [...vi.mocked(haPostText).mock.calls, ...vi.mocked(haPostJson).mock.calls]
    .map(([p]) => String(p))
    .filter((p) => p.startsWith("/api/services/cover/"))
    .map((p) => p.split("/").pop());
const flush = () => calibrationStore.mutate(() => false);

beforeEach(async () => {
  docs.reset();
  silenceConsole();
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cover-percent-"));
  await calibrationStore.load();
  vi.mocked(haGet).mockReset().mockResolvedValue([COVER_STATE]);
  vi.mocked(haGetOptional).mockReset().mockResolvedValue(COVER_STATE);
  vi.mocked(haPostJson).mockReset().mockResolvedValue([]);
  vi.mocked(haPostText).mockReset().mockResolvedValue("");
});

afterEach(async () => {
  // The default CoverMoves instance is module-level: drain leftover moves so they do not leak into the next test.
  await vi.runAllTimersAsync();
  await flush();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Seeds a calibration through the real store (no HA call). */
async function calibrate(position: number | null = null, id = ENTITY) {
  await calibrationStore.mutate((d) => {
    d.set(id, { openMs: OPEN_MS, closeMs: CLOSE_MS, position, calibratedAt: "2026-01-01T00:00:00.000Z" });
    return true;
  });
}

describe("parsePercent", () => {
  it("accepts integers 0..100", () => {
    expect(parsePercent({ percent: 0 })).toBe(0);
    expect(parsePercent({ percent: 100 })).toBe(100);
    expect(parsePercent({ percent: 37 })).toBe(37);
  });

  it("rejects missing, out of range, fractional and non-number values with invalid_params", () => {
    for (const body of [undefined, null, {}, { percent: 101 }, { percent: -1 }, { percent: 1.5 }, { percent: "50" }]) {
      expect(() => parsePercent(body)).toThrow(InvalidParamsError);
    }
  });
});

describe("setCoverPercent validation order", () => {
  it("rejects a bad id or a non-cover domain before any HA call", async () => {
    await expect(setCoverPercent("BAD", { percent: 5 })).rejects.toBeInstanceOf(InvalidEntityIdError);
    await expect(setCoverPercent("light.a", { percent: 5 })).rejects.toBeInstanceOf(DomainNotAllowedError);
    expect(haGet).not.toHaveBeenCalled();
  });

  it("rejects an invalid percent before the calibration check and any HA call (400)", async () => {
    await expect(setCoverPercent(ENTITY, { percent: 101 })).rejects.toBeInstanceOf(InvalidParamsError);
    expect(haGet).not.toHaveBeenCalled();
  });

  it("returns not_calibrated (409) for an uncalibrated cover without calling HA", async () => {
    await expect(setCoverPercent(ENTITY, { percent: 50 })).rejects.toBeInstanceOf(NotCalibratedError);
    expect(haGet).not.toHaveBeenCalled();
    expect(haPostText).not.toHaveBeenCalled();
  });

  it("returns entity_not_found (404) for a calibrated cover that HA does not know", async () => {
    await calibrate(0, "cover.bruno_missing_test");
    vi.mocked(haGetOptional).mockResolvedValueOnce(null);
    await expect(setCoverPercent("cover.bruno_missing_test", { percent: 100 })).rejects.toBeInstanceOf(EntityNotFoundError);
    expect(haPostText).not.toHaveBeenCalled();
  });

  it("returns position_unknown (409) for an intermediate target on an unknown position", async () => {
    await calibrate(null);
    await expect(setCoverPercent(ENTITY, { percent: 50 })).rejects.toBeInstanceOf(PositionUnknownError);
    expect(haPostText).not.toHaveBeenCalled();
  });
});

describe("setCoverPercent success", () => {
  it("drives the cover and returns one normalized entity with estimated_position", async () => {
    await calibrate(0);
    const [entity] = await setCoverPercent(ENTITY, { percent: 100 });
    expect(entity).toMatchObject({ entityId: ENTITY, domain: "cover", state: "closed" });
    expect(entity.attributes.estimated_position).toBe(0);
    expect(services()).toEqual(["open_cover"]);
  });

  it("uses the timed stop for intermediate targets and persists the reached position", async () => {
    await calibrate(0);
    await setCoverPercent(ENTITY, { percent: 50 });
    await vi.advanceTimersByTimeAsync(OPEN_MS / 2);
    await flush();
    expect(services()).toEqual(["open_cover", "stop_cover"]);
    expect(calibrationStore.get(ENTITY)?.position).toBe(50);
  });
});

describe("normalized cover attributes", () => {
  it("adds estimated_position to covers only (null when uncalibrated)", () => {
    const cover = normalizeEntity(COVER_STATE, new Map());
    expect(cover.attributes).toEqual({ friendly_name: "Kitchen cover", estimated_position: null });

    const light = normalizeEntity({ ...COVER_STATE, entity_id: "light.a" }, new Map());
    expect(light.attributes).not.toHaveProperty("estimated_position");
  });

  it("reports the stored position once calibrated", async () => {
    await calibrate(42);
    expect(normalizeEntity(COVER_STATE, new Map()).attributes.estimated_position).toBe(42);
  });
});

describe("cover action endpoint integration", () => {
  it("stop_cover cancels a running timed move and reports the elapsed estimate", async () => {
    await calibrate(0);
    await setCoverPercent(ENTITY, { percent: 100 });
    await vi.advanceTimersByTimeAsync(OPEN_MS / 2);

    const entity = await controlEntity(ENTITY, { action: "stop_cover" });
    expect(services()).toEqual(["open_cover", "stop_cover"]);
    await flush();
    expect(calibrationStore.get(ENTITY)?.position).toBe(50);
    expect(entity.attributes.estimated_position).toBe(50);

    await vi.advanceTimersByTimeAsync(CLOSE_MS * 2);
    expect(services()).toEqual(["open_cover", "stop_cover"]);
  });

  it("open_cover on a calibrated cover reports the position as unknown during the leg", async () => {
    await calibrate(10);
    const entity = await controlEntity(ENTITY, { action: "open_cover" });
    expect(entity.attributes.estimated_position).toBe(null);
    await vi.advanceTimersByTimeAsync(Math.round(OPEN_MS * 1.1));
    await flush();
    expect(calibrationStore.get(ENTITY)?.position).toBe(100);
  });
});

describe("EntitiesController.coverPercent", () => {
  it("responds with the envelope on success and the typed error code on failure", async () => {
    await calibrate(0);
    const ok = fakeRes();
    await EntitiesController.coverPercent({ params: { entityId: ENTITY }, body: { percent: 100 } } as any, ok as any);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data[0].entityId).toBe(ENTITY);

    const bad = fakeRes();
    await EntitiesController.coverPercent({ params: { entityId: "cover.none" }, body: { percent: 50 } } as any, bad as any);
    expect(bad.statusCode).toBe(409);
    expect(bad.body.error).toBe("not_calibrated");
  });
});
