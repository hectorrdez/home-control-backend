import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RETENTION_DAYS,
  parseRetentionDays,
  purgeOldRows,
  startEventRetention,
} from "@modules/events/EventRetention";
import Logger from "@utils/Logger";
import { silenceConsole } from "./helpers";

beforeEach(() => {
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.EVENTS_RETENTION_DAYS;
});

describe("parseRetentionDays", () => {
  it.each([
    [undefined, 365],
    ["", 365],
    ["   ", 365],
    ["1", 1],
    ["30", 30],
    ["3650", 3650],
    ["0", 365],
    ["3651", 365],
    ["-5", 365],
    ["2.5", 365],
    ["abc", 365],
    ["1e2x", 365],
  ])("EVENTS_RETENTION_DAYS=%j -> %i", (raw, expected) => {
    expect(parseRetentionDays(raw)).toBe(expected);
  });

  it("defaults to 365", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(365);
  });
});

describe("purgeOldRows", () => {
  it("deletes by a parameterized window and returns the row counts", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 7 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const counts = await purgeOldRows({ query }, 30);
    expect(counts).toEqual({ events: 7, alerts: 2 });
    expect(query.mock.calls[0]).toEqual([
      "DELETE FROM events WHERE ts < now() - make_interval(days => $1)",
      [30],
    ]);
    expect(query.mock.calls[1][0]).toContain("DELETE FROM alerts");
    expect(query.mock.calls[1][0]).toContain("acked_at IS NOT NULL");
    expect(query.mock.calls[1][1]).toEqual([30]);
  });

  // Alert age is measured by fired_at. The predicate must be exactly:
  //   acked_at IS NOT NULL AND fired_at < cutoff
  // so: old+acked -> deleted; old+unacked -> kept (no acked_at); recent+acked -> kept (fired_at recent),
  // even when acked_at is itself old. The unit layer has no Postgres, so the clause is asserted verbatim.
  it("deletes alerts by fired_at age, only when acked (old+acked deleted; unacked or recent kept)", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await purgeOldRows({ query }, 30);
    const sql: string = query.mock.calls[1][0];
    expect(sql).toContain("acked_at IS NOT NULL AND fired_at < now() - make_interval(days => $1)");
    expect(sql).not.toContain("acked_at < now()");
  });

  it("treats a missing rowCount as zero", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: null });
    expect(await purgeOldRows({ query }, 1)).toEqual({ events: 0, alerts: 0 });
  });
});

describe("startEventRetention", () => {
  it("runs the first purge after one minute, then hourly, and stops on request", async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const stop = startEventRetention({ db: { query }, days: 90 });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual([90]);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(query).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("logs the deleted count at INFO only when rows were removed", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(Logger, "write").mockImplementation(() => undefined);
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 3 });
    const stop = startEventRetention({ db: { query }, days: 10 });
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    expect(write).toHaveBeenCalledWith(expect.stringContaining("retention deleted 3 events"), "EVENTS");
  });

  it("logs a failed run and keeps the job alive", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined);
    const query = vi.fn().mockRejectedValue(new Error("db gone"));
    const stop = startEventRetention({ db: { query }, days: 10 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("db gone"), "EVENTS");
    // A failed events delete stops the run before the alerts delete: one query per run.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(query).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reads EVENTS_RETENTION_DAYS and warns once when it is invalid", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(Logger, "write").mockImplementation(() => undefined);
    process.env.EVENTS_RETENTION_DAYS = "9000";
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const stop = startEventRetention({ db: { query } });
    expect(write).toHaveBeenCalledWith(expect.stringContaining("EVENTS_RETENTION_DAYS invalid"), "EVENTS", "WARN");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query.mock.calls[0][1]).toEqual([365]);
    stop();
  });

  it("uses the configured days when valid and does not warn", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(Logger, "write").mockImplementation(() => undefined);
    process.env.EVENTS_RETENTION_DAYS = "7";
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const stop = startEventRetention({ db: { query } });
    expect(write).not.toHaveBeenCalledWith(expect.anything(), "EVENTS", "WARN");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(query.mock.calls[0][1]).toEqual([7]);
    stop();
  });
});
