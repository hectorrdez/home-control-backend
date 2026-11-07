import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import calibrationStore from "@modules/calibrations/CalibrationStore";
import CalibrationsController from "@modules/calibrations/CalibrationsController";
import calibrationsRoutes from "@modules/calibrations/calibrations.routes";
import {
  CalibrationWriteFailedError,
  InvalidCalibrationError,
  TooManyCalibrationsError,
} from "@modules/calibrations/CalibrationErrors";
import { fakeRes, silenceConsole } from "./helpers";

let dir: string;
let file: string;

beforeEach(() => {
  silenceConsole();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "calib-ctrl-"));
  file = path.join(dir, "calibrations.json");
  calibrationStore.load(file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (entityId: string, body?: unknown) => ({ params: { entityId }, body }) as any;

describe("CalibrationsController", () => {
  it("put stores the calibration and responds with the envelope data", async () => {
    const res = fakeRes();
    await CalibrationsController.put(req("cover.kitchen", { openMs: 15000, closeMs: 14000 }), res as any);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).toContain("cover.kitchen");
    expect(calibrationStore.get("cover.kitchen")).toMatchObject({ openMs: 15000, closeMs: 14000, position: null });
  });

  it("put rejects an invalid body with the calibration error and stores nothing", async () => {
    const res = fakeRes();
    await CalibrationsController.put(req("cover.kitchen", { openMs: 10 }), res as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("invalid_calibration");
    expect(calibrationStore.list()).toEqual([]);
  });

  it("delete removes the calibration and responds with an empty array", async () => {
    await CalibrationsController.put(req("cover.kitchen", { openMs: 15000, closeMs: 14000 }), fakeRes() as any);
    const res = fakeRes();
    await CalibrationsController.delete(req("cover.kitchen"), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(calibrationStore.get("cover.kitchen")).toBeUndefined();
  });

  it("delete is idempotent for unknown covers", async () => {
    const res = fakeRes();
    await CalibrationsController.delete(req("cover.nope"), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("delete reports an invalid entity id with a 400 envelope", async () => {
    const res = fakeRes();
    await CalibrationsController.delete(req("BAD"), res as any);
    expect(res.statusCode).toBe(400);
  });
});

describe("calibrations routes", () => {
  it("declares GET /calibrations and PUT/DELETE /calibrations/:entityId", () => {
    const layers = (calibrationsRoutes as any).stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    const declared = layers
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`);
    expect(declared.sort()).toEqual(
      ["DELETE /calibrations/:entityId", "GET /calibrations", "PUT /calibrations/:entityId"].sort()
    );
  });
});

describe("calibrations error classes", () => {
  it("carry the HTTP status and stable error code", () => {
    const invalid = new InvalidCalibrationError();
    expect(invalid.getCode()).toBe(400);
    expect(invalid.getErrorCode()).toBe("invalid_calibration");
    expect(invalid.getMessage()).toContain("500 and 300000");

    const full = new TooManyCalibrationsError();
    expect(full.getCode()).toBe(400);
    expect(full.getErrorCode()).toBe("too_many_calibrations");
    expect(full.getMessage()).toContain("200");

    const write = new CalibrationWriteFailedError();
    expect(write.getCode()).toBe(500);
    expect(write.getErrorCode()).toBe("calibrations_write_failed");
  });

  it("accept a custom message", () => {
    expect(new InvalidCalibrationError("custom").getMessage()).toBe("custom");
    expect(new TooManyCalibrationsError("full").getMessage()).toBe("full");
    expect(new CalibrationWriteFailedError("nope").getMessage()).toBe("nope");
  });
});
