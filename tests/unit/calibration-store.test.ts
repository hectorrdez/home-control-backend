import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalibrationStore } from "@modules/calibrations/CalibrationStore";
import { CalibrationWriteFailedError } from "@modules/calibrations/CalibrationErrors";
import { silenceConsole } from "./helpers";

let dir: string;
let file: string;

const valid = (over: Record<string, unknown> = {}) => ({
  openMs: 15000,
  closeMs: 14000,
  position: null,
  calibratedAt: "2026-11-07T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "calib-store-"));
  file = path.join(dir, "nested", "calibrations.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const readJson = () => JSON.parse(fs.readFileSync(file, "utf8"));
const logText = (con: { log: ReturnType<typeof vi.spyOn> }) =>
  con.log.mock.calls.map((c) => String(c[0])).join("\n");

describe("CalibrationStore load", () => {
  it("starts empty when the file does not exist yet", () => {
    const store = new CalibrationStore();
    store.load(file);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("loads a valid file and lists entries sorted by entity id", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, covers: { "cover.b": valid(), "cover.a": valid({ openMs: 9000 }) } })
    );
    const store = new CalibrationStore();
    store.load(file);
    expect(store.list().map((e) => e.entityId)).toEqual(["cover.a", "cover.b"]);
    expect(store.get("cover.a")?.openMs).toBe(9000);
  });

  it("skips invalid entries on load and logs how many were ignored", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const con = silenceConsole();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        covers: {
          "cover.ok": valid(),
          "light.wrong_domain": valid(),
          "COVER.Bad": valid(),
          "cover.short": valid({ openMs: 100 }),
          "cover.frac": valid({ closeMs: 1.5 }),
          "cover.pos": valid({ position: 150 }),
          "cover.nots": valid({ calibratedAt: 5 }),
          "cover.str": "nope",
        },
      })
    );
    const store = new CalibrationStore();
    store.load(file);
    expect(store.list().map((e) => e.entityId)).toEqual(["cover.ok"]);
    expect(logText(con)).toContain("ignored 7 invalid calibration entries");
  });

  it("moves an unparseable file aside and starts empty", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    silenceConsole();
    fs.writeFileSync(file, "{not json");
    const store = new CalibrationStore();
    store.load(file);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    const moved = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith("calibrations.json.corrupt-"));
    expect(moved).toHaveLength(1);
  });

  it("moves a file with the wrong version or a non-object covers field aside", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    silenceConsole();
    for (const body of [
      JSON.stringify({ version: 2, covers: {} }),
      JSON.stringify({ version: 1, covers: [] }),
      JSON.stringify({ version: 1 }),
      "null",
    ]) {
      fs.writeFileSync(file, body);
      const store = new CalibrationStore();
      store.load(file);
      expect(store.list()).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
  });

  it("still starts empty when the corrupt file cannot be moved aside", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const con = silenceConsole();
    fs.writeFileSync(file, "garbage");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("locked");
    });
    const store = new CalibrationStore();
    expect(() => store.load(file)).not.toThrow();
    expect(store.list()).toEqual([]);
    expect(logText(con)).toContain("could not move it aside");
  });
});

describe("CalibrationStore mutate", () => {
  it("persists a sorted, versioned file atomically and leaves no tmp file behind", async () => {
    const store = new CalibrationStore();
    store.load(file);
    await store.mutate((d) => {
      d.set("cover.b", valid());
      d.set("cover.a", valid({ openMs: 9000 }));
      return true;
    });
    const body = readJson();
    expect(body.version).toBe(1);
    expect(Object.keys(body.covers)).toEqual(["cover.a", "cover.b"]);
    expect(body.covers["cover.a"].openMs).toBe(9000);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(store.list()).toHaveLength(2);
  });

  it("does not write when the change reports no modification", async () => {
    const store = new CalibrationStore();
    store.load(file);
    await store.mutate(() => false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("publishes nothing when the change callback throws", async () => {
    const store = new CalibrationStore();
    store.load(file);
    await store.mutate((d) => {
      d.set("cover.a", valid());
      return true;
    });
    await expect(
      store.mutate((d) => {
        d.set("cover.b", valid());
        throw new Error("validation");
      })
    ).rejects.toThrow("validation");
    expect(store.get("cover.b")).toBeUndefined();
    expect(Object.keys(readJson().covers)).toEqual(["cover.a"]);
  });

  it("serializes concurrent mutations so none are lost", async () => {
    const store = new CalibrationStore();
    store.load(file);
    const set = (id: string) =>
      store.mutate((d) => {
        d.set(id, valid());
        return true;
      });
    await Promise.all([set("cover.a"), set("cover.b"), set("cover.c")]);
    expect(store.list().map((e) => e.entityId)).toEqual(["cover.a", "cover.b", "cover.c"]);
    expect(Object.keys(readJson().covers)).toHaveLength(3);
  });

  it("keeps memory unchanged and removes the tmp file when the write fails", async () => {
    const store = new CalibrationStore();
    store.load(file);
    silenceConsole();
    await store.mutate((d) => {
      d.set("cover.a", valid());
      return true;
    });

    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("disk full"));
    const err = await store
      .mutate((d) => {
        d.set("cover.a", valid({ openMs: 1000 }));
        return true;
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(CalibrationWriteFailedError);
    expect(err.getCode()).toBe(500);
    expect(store.get("cover.a")?.openMs).toBe(15000);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(readJson().covers["cover.a"].openMs).toBe(15000);
  });
});

describe("CalibrationStore write failure details", () => {
  it("wraps a non-Error write failure in CalibrationWriteFailedError", async () => {
    silenceConsole();
    const store = new CalibrationStore();
    store.load(file);
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce("disk gone");
    await expect(
      store.mutate((d) => {
        d.set("cover.a", valid());
        return true;
      })
    ).rejects.toBeInstanceOf(CalibrationWriteFailedError);
    expect(store.list()).toEqual([]);
  });
});
