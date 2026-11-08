import { afterEach, describe, expect, it, vi } from "vitest";
import { silenceConsole, startApp } from "./helpers";
import { isDbUp, markDbDown, markDbUp, startDbPing } from "../../src/db/health";

afterEach(() => {
  vi.useRealTimers();
  markDbDown();
});

describe("db liveness flag", () => {
  it("pings on the interval and follows the result", async () => {
    vi.useFakeTimers();
    silenceConsole();
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockRejectedValueOnce(new Error("gone"))
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    const timer = startDbPing(db, 30000);
    await vi.advanceTimersByTimeAsync(30000);
    expect(isDbUp()).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(isDbUp()).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(isDbUp()).toBe(true);
    expect(db.query).toHaveBeenCalledWith("SELECT 1");
    clearInterval(timer);
  });

  it("markDbUp / markDbDown set the flag", () => {
    markDbUp();
    expect(isDbUp()).toBe(true);
    markDbDown();
    expect(isDbUp()).toBe(false);
  });
});

describe("GET /api/health db field", () => {
  it("reports db up when the flag is true, still 200", async () => {
    const app = await startApp();
    try {
      // startApp resets the module graph; flip the flag on the instance the app just loaded.
      const health = await import("../../src/db/health");
      health.markDbUp();
      const res = await fetch(`${app.base}/health`);
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([{ online: true, db: "up", haCache: "off" }]);
    } finally {
      await app.close();
    }
  });
});
