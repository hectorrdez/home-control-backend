import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import calibrationStore from "@modules/calibrations/CalibrationStore";
import {
  deleteCalibration,
  listCalibrations,
  setCalibration,
} from "@modules/calibrations/CalibrationsService";
import { parseCalibrationBody, isValidDurationMs, MAX_CALIBRATIONS } from "@modules/calibrations/CalibrationValidation";
import {
  InvalidCalibrationError,
  TooManyCalibrationsError,
} from "@modules/calibrations/CalibrationErrors";
import { DomainNotAllowedError, InvalidEntityIdError } from "@modules/entities/EntityErrors";
import { silenceConsole } from "./helpers";
const docs = await vi.hoisted(async () => (await import("./fake-documents-db")).createFakeDocumentDb());
vi.mock("pg", () => ({ Pool: class { constructor() { return Object.assign(docs, { on: () => undefined }); } } }));

let dir: string;
let file: string;

beforeEach(async () => {
  docs.reset();
  silenceConsole();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "calib-svc-"));
  file = path.join(dir, "calibrations.json");
  await calibrationStore.load();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("calibrations validation", () => {
  it("accepts integers from 500 to 300000 only", () => {
    expect(isValidDurationMs(500)).toBe(true);
    expect(isValidDurationMs(300000)).toBe(true);
    expect(isValidDurationMs(499)).toBe(false);
    expect(isValidDurationMs(300001)).toBe(false);
    expect(isValidDurationMs(1.5)).toBe(false);
    expect(isValidDurationMs("15000")).toBe(false);
  });

  it("parses the PUT body and rejects missing or invalid fields", () => {
    expect(parseCalibrationBody({ openMs: 15000, closeMs: 14000 })).toEqual({ openMs: 15000, closeMs: 14000 });
    expect(() => parseCalibrationBody(undefined)).toThrow(InvalidCalibrationError);
    expect(() => parseCalibrationBody({ openMs: 15000 })).toThrow(InvalidCalibrationError);
    expect(() => parseCalibrationBody({ openMs: 15000, closeMs: 400 })).toThrow(InvalidCalibrationError);
  });

  it("exposes the 200 covers cap", () => {
    expect(MAX_CALIBRATIONS).toBe(200);
  });
});

describe("calibrations service", () => {
  it("setCalibration stores the entry with position null and returns it", async () => {
    const [entry] = await setCalibration("cover.a", { openMs: 15000, closeMs: 14000 });
    expect(entry).toMatchObject({ entityId: "cover.a", openMs: 15000, closeMs: 14000, position: null });
    expect(typeof entry.calibratedAt).toBe("string");
    expect(listCalibrations()).toEqual([entry]);
    expect(docs.snapshot("calibrations")["cover.a"].openMs).toBe(15000);
  });

  it("setCalibration replaces an existing entry and resets position", async () => {
    await setCalibration("cover.a", { openMs: 15000, closeMs: 14000 });
    await setCalibration("cover.a", { openMs: 16000, closeMs: 15000 });
    const list = listCalibrations();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ openMs: 16000, closeMs: 15000, position: null });
  });

  it("setCalibration validates the entity id, domain and body before touching the store", async () => {
    await expect(setCalibration("BAD", { openMs: 15000, closeMs: 14000 })).rejects.toBeInstanceOf(InvalidEntityIdError);
    await expect(setCalibration("light.a", { openMs: 15000, closeMs: 14000 })).rejects.toBeInstanceOf(
      DomainNotAllowedError
    );
    await expect(setCalibration("cover.a", { openMs: 1, closeMs: 14000 })).rejects.toBeInstanceOf(
      InvalidCalibrationError
    );
    expect(listCalibrations()).toEqual([]);
    expect(docs.statements.filter((q) => q.startsWith("INSERT"))).toEqual([]);
  });

  it("refuses a new cover once 200 exist, but still allows replacing one", async () => {
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      seeded[`cover.e${i}`] = { openMs: 1000, closeMs: 1000, position: null, calibratedAt: "2026-01-01T00:00:00.000Z" };
    }
    docs.seed("calibrations", seeded);
    await calibrationStore.load();

    await expect(setCalibration("cover.new", { openMs: 1000, closeMs: 1000 })).rejects.toBeInstanceOf(
      TooManyCalibrationsError
    );
    await expect(setCalibration("cover.e0", { openMs: 2000, closeMs: 2000 })).resolves.toMatchObject([
      { entityId: "cover.e0", openMs: 2000 },
    ]);
  });

  it("deleteCalibration removes the entry and always returns an empty array", async () => {
    await setCalibration("cover.a", { openMs: 15000, closeMs: 14000 });
    await expect(deleteCalibration("cover.a")).resolves.toEqual([]);
    expect(listCalibrations()).toEqual([]);
  });

  it("deleteCalibration is idempotent and validates the entity id and domain", async () => {
    await expect(deleteCalibration("cover.nope")).resolves.toEqual([]);
    expect(docs.statements.filter((q) => q.startsWith("INSERT"))).toEqual([]);
    await expect(deleteCalibration("nope")).rejects.toBeInstanceOf(InvalidEntityIdError);
    await expect(deleteCalibration("switch.a")).rejects.toBeInstanceOf(DomainNotAllowedError);
  });
});
