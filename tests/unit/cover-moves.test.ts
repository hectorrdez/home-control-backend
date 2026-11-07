import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalibrationStore, CalibrationRecord } from "@modules/calibrations/CalibrationStore";
import { CoverMoves, defaultCoverMoveDeps } from "@modules/covers/CoverMoves";
import { NotCalibratedError, PositionUnknownError } from "@modules/covers/CoverMoveErrors";
import { silenceConsole } from "./helpers";

const ENTITY = "cover.kitchen";
const OPEN_MS = 10000;
const CLOSE_MS = 20000;

let dir: string;
let store: CalibrationStore;
let post: ReturnType<typeof vi.fn>;
let moves: CoverMoves;

/** Stores a calibration with the given position. Writes through the real store so persistence is exercised. */
async function calibrate(position: number | null = null) {
  await store.mutate((d) => {
    const record: CalibrationRecord = { openMs: OPEN_MS, closeMs: CLOSE_MS, position, calibratedAt: "2026-01-01T00:00:00.000Z" };
    d.set(ENTITY, record);
    return true;
  });
}

/** Waits until every queued store write has landed. */
const flush = () => store.mutate(() => false);
const stored = () => store.get(ENTITY)?.position;
const services = () => post.mock.calls.map(([p]) => String(p).split("/").pop());

beforeEach(() => {
  silenceConsole();
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cover-moves-"));
  store = new CalibrationStore();
  store.load(path.join(dir, "calibrations.json"));
  post = vi.fn(async () => "");
  moves = new CoverMoves({ ...defaultCoverMoveDeps, store, post });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CoverMoves.moveTo", () => {
  it("opens for the proportional time from a known position, then stops and persists the target", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 50);
    expect(services()).toEqual(["open_cover"]);
    await vi.advanceTimersByTimeAsync(OPEN_MS / 2 - 1);
    expect(services()).toEqual(["open_cover"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(services()).toEqual(["open_cover", "stop_cover"]);
    await flush();
    expect(stored()).toBe(50);
  });

  it("closes for the proportional time when the target is below the known position", async () => {
    await calibrate(80);
    await moves.moveTo(ENTITY, 30);
    expect(services()).toEqual(["close_cover"]);
    await vi.advanceTimersByTimeAsync((CLOSE_MS * 50) / 100);
    expect(services()).toEqual(["close_cover", "stop_cover"]);
    await flush();
    expect(stored()).toBe(30);
  });

  it("sends the HA entity id to the cover service path", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 10);
    expect(post).toHaveBeenCalledWith("/api/services/cover/open_cover", { entity_id: ENTITY });
  });

  it("drives the full open leg with no stop for target 100 even when the position is unknown", async () => {
    await calibrate(null);
    await moves.moveTo(ENTITY, 100);
    expect(services()).toEqual(["open_cover"]);
    await vi.advanceTimersByTimeAsync(Math.round(OPEN_MS * 1.1) - 1);
    await flush();
    expect(stored()).toBe(null);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(services()).toEqual(["open_cover"]);
    expect(stored()).toBe(100);
  });

  it("drives the full close leg for target 0 with the 10% margin", async () => {
    await calibrate(40);
    await moves.moveTo(ENTITY, 0);
    expect(services()).toEqual(["close_cover"]);
    await vi.advanceTimersByTimeAsync(Math.round(CLOSE_MS * 1.1));
    await flush();
    expect(stored()).toBe(0);
    expect(services()).toEqual(["close_cover"]);
  });

  it("rejects an intermediate target with unknown position before any HA call", async () => {
    await calibrate(null);
    await expect(moves.moveTo(ENTITY, 50)).rejects.toBeInstanceOf(PositionUnknownError);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects an uncalibrated cover before any HA call", async () => {
    await expect(moves.moveTo(ENTITY, 50)).rejects.toBeInstanceOf(NotCalibratedError);
    await expect(moves.moveTo(ENTITY, 0)).rejects.toBeInstanceOf(NotCalibratedError);
    expect(post).not.toHaveBeenCalled();
  });

  it("does nothing when the intermediate target equals the known position", async () => {
    await calibrate(60);
    await moves.moveTo(ENTITY, 60);
    expect(post).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a running move on a new request, sends stop_cover and plans from the elapsed estimate", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 100);
    await vi.advanceTimersByTimeAsync(OPEN_MS / 2);
    expect(moves.estimatedPosition(ENTITY)).toBe(50);

    await moves.moveTo(ENTITY, 20);
    expect(services()).toEqual(["open_cover", "stop_cover", "close_cover"]);
    await flush();
    expect(stored()).toBe(null); // new move in flight: unknown until it ends

    await vi.advanceTimersByTimeAsync((CLOSE_MS * 30) / 100);
    await flush();
    expect(services()).toEqual(["open_cover", "stop_cover", "close_cover", "stop_cover"]);
    expect(stored()).toBe(20);
  });

  it("keeps HA's first stop as the only stop when a cancelled full leg is replaced", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 100);
    await vi.advanceTimersByTimeAsync(1000);
    await moves.moveTo(ENTITY, 100);
    expect(services()).toEqual(["open_cover", "stop_cover", "open_cover"]);
    await vi.advanceTimersByTimeAsync(Math.round(OPEN_MS * 1.1));
    await flush();
    expect(stored()).toBe(100);
  });

  it("keeps an unknown estimate when a running move had no known start position", async () => {
    await calibrate(null);
    await moves.moveTo(ENTITY, 100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(moves.estimatedPosition(ENTITY)).toBe(null);
    await expect(moves.moveTo(ENTITY, 40)).rejects.toBeInstanceOf(PositionUnknownError);
    expect(services()).toEqual(["open_cover"]);
  });

  it("propagates an HA failure on the initial command and leaves no timer behind", async () => {
    await calibrate(0);
    post.mockRejectedValueOnce(new Error("ha down"));
    await expect(moves.moveTo(ENTITY, 50)).rejects.toThrow("ha down");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("CoverMoves live estimate", () => {
  it("exposes the stored position when no move runs and the live estimate while one runs", async () => {
    await calibrate(20);
    expect(moves.estimatedPosition(ENTITY)).toBe(20);
    await moves.moveTo(ENTITY, 100);
    await vi.advanceTimersByTimeAsync(OPEN_MS / 4);
    expect(moves.estimatedPosition(ENTITY)).toBe(45);
  });

  it("clamps the live estimate into 0..100 and reports null for an uncalibrated cover", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 100);
    await vi.advanceTimersByTimeAsync(Math.round(OPEN_MS * 1.05));
    expect(moves.estimatedPosition(ENTITY)).toBe(100);
    expect(moves.estimatedPosition("cover.nope")).toBe(null);
  });
});

describe("CoverMoves.onAction", () => {
  it("stop_cover cancels the timer, sends nothing extra and persists the elapsed estimate", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 100);
    await vi.advanceTimersByTimeAsync(OPEN_MS / 2);
    await moves.onAction(ENTITY, "stop_cover", async () => post("/api/services/cover/stop_cover", {}));
    await flush();
    expect(stored()).toBe(50);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(OPEN_MS * 2);
    expect(services()).toEqual(["open_cover", "stop_cover"]);
  });

  it("stop_cover with no running move leaves the stored position alone", async () => {
    await calibrate(35);
    await moves.onAction(ENTITY, "stop_cover", async () => "");
    await flush();
    expect(stored()).toBe(35);
  });

  it("open_cover starts a full leg from unknown: position unknown until the leg time passes, then 100", async () => {
    await calibrate(10);
    await moves.onAction(ENTITY, "open_cover", async () => "");
    await flush();
    expect(stored()).toBe(null);
    expect(moves.estimatedPosition(ENTITY)).toBe(null);
    await vi.advanceTimersByTimeAsync(Math.round(OPEN_MS * 1.1));
    await flush();
    expect(stored()).toBe(100);
  });

  it("close_cover ends at 0 after the close leg", async () => {
    await calibrate(50);
    await moves.onAction(ENTITY, "close_cover", async () => "");
    await vi.advanceTimersByTimeAsync(Math.round(CLOSE_MS * 1.1));
    await flush();
    expect(stored()).toBe(0);
  });

  it("open_cover on an uncalibrated cover only sends the command and starts no timer", async () => {
    const send = vi.fn(async () => "");
    await moves.onAction("cover.nope", "open_cover", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("set_cover_position and toggle make the position unknown and cancel a running move", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 100);
    await moves.onAction(ENTITY, "set_cover_position", async () => "");
    await flush();
    expect(stored()).toBe(null);
    expect(vi.getTimerCount()).toBe(0);

    await calibrate(70);
    await moves.onAction(ENTITY, "toggle", async () => "");
    await flush();
    expect(stored()).toBe(null);
  });

  it("propagates an HA failure of the action command", async () => {
    await calibrate(15);
    await expect(
      moves.onAction(ENTITY, "stop_cover", async () => {
        throw new Error("ha down");
      })
    ).rejects.toThrow("ha down");
  });
});

describe("CoverMoves timer failures and restart", () => {
  it("logs a failed stop_cover at timer end and still persists the target", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 50);
    post.mockRejectedValueOnce(new Error("ha down"));
    await vi.advanceTimersByTimeAsync(OPEN_MS / 2);
    await flush();
    expect(stored()).toBe(50);
  });

  it("a move that never ended leaves position null after a restart (timers are not persisted)", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 100);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    const restarted = new CalibrationStore();
    restarted.load(path.join(dir, "calibrations.json"));
    expect(restarted.get(ENTITY)?.position).toBe(null);
    expect(new CoverMoves({ ...defaultCoverMoveDeps, store: restarted, post }).estimatedPosition(ENTITY)).toBe(null);
  });

  it("does not write when the calibration disappears during a move", async () => {
    await calibrate(0);
    await moves.moveTo(ENTITY, 50);
    await store.mutate((d) => d.delete(ENTITY));
    await vi.advanceTimersByTimeAsync(OPEN_MS);
    await flush();
    expect(store.get(ENTITY)).toBeUndefined();
  });

  it("swallows a persistence failure without rejecting the timer path", async () => {
    await calibrate(0);
    const failing = new CoverMoves({
      ...defaultCoverMoveDeps,
      store: Object.assign(Object.create(store), {
        mutate: () => Promise.reject(new Error("disk full")),
        get: (id: string) => store.get(id),
      }) as CalibrationStore,
      post,
    });
    await expect(failing.moveTo(ENTITY, 100)).resolves.toBeUndefined();
    expect(services()).toEqual(["open_cover"]);
  });
});

describe("CoverMoves default dependencies", () => {
  it("uses the wall clock and real timers when no deps are injected", () => {
    expect(typeof defaultCoverMoveDeps.now()).toBe("number");
    expect(defaultCoverMoveDeps.store.get("cover.none")).toBeUndefined();
    expect(new CoverMoves().estimatedPosition("cover.none")).toBe(null);
  });
});
