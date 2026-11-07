import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silenceConsole } from "./helpers";
import { connectDb, CONNECT_RETRY_DELAYS_MS } from "../../src/db/connect";
import { isDbUp, markDbDown } from "../../src/db/health";

beforeEach(() => {
  vi.useFakeTimers();
  silenceConsole();
});

afterEach(() => {
  vi.useRealTimers();
  markDbDown();
});

describe("connectDb", () => {
  it("retries and succeeds once the db answers", async () => {
    const db = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error("refused"))
        .mockRejectedValueOnce(new Error("refused"))
        .mockResolvedValue({ rows: [], rowCount: 1 }),
    };
    const done = connectDb(db);
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    await done;
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(db.query).toHaveBeenCalledWith("SELECT 1");
    expect(isDbUp()).toBe(true);
  });

  it("uses the delays 1s, 2s, 4s, 8s, 15s, 30s", () => {
    expect(CONNECT_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 15000, 30000]);
  });

  it("gives up after the whole schedule and throws the last error", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("still down")) };
    const failed = expect(connectDb(db)).rejects.toThrow("still down");
    await vi.runAllTimersAsync();
    await failed;
    expect(db.query).toHaveBeenCalledTimes(CONNECT_RETRY_DELAYS_MS.length + 1);
    expect(isDbUp()).toBe(false);
  });
});
