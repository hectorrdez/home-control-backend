import { beforeEach, describe, expect, it, vi } from "vitest";
import { silenceConsole } from "./helpers";

const fakes = vi.hoisted(() => {
  const client = { query: vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 })), release: vi.fn() };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
    // Plain function, not vi.fn: restoreMocks would wipe the handler captured at import time.
    on: (event: string, fn: (e: Error) => void) => {
      if (event === "error") onError.handler = fn;
    },
  };
  const onError: { handler?: (e: Error) => void } = {};
  return { client, pool, onError };
});

vi.mock("pg", () => ({
  Pool: class {
    constructor() {
      return fakes.pool as any;
    }
  },
}));

import { withTransaction, query, pool } from "../../src/db/pool";
import { isDbUp, markDbDown } from "../../src/db/health";

const sqlCalls = () => fakes.client.query.mock.calls.map((c) => c[0]);

beforeEach(() => {
  fakes.client.query.mockReset();
  fakes.client.query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  fakes.client.release.mockClear();
  fakes.pool.connect.mockClear();
  markDbDown();
});

describe("withTransaction", () => {
  it("runs fn between BEGIN and COMMIT on one client and releases it", async () => {
    const result = await withTransaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES (1)");
      return "done";
    });
    expect(result).toBe("done");
    expect(sqlCalls()).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]);
    expect(fakes.client.release).toHaveBeenCalledTimes(1);
    expect(fakes.client.release).toHaveBeenCalledWith(false);
  });

  it("rolls back, rethrows and releases the client when fn throws", async () => {
    await expect(
      withTransaction(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(sqlCalls()).toEqual(["BEGIN", "ROLLBACK"]);
    expect(fakes.client.release).toHaveBeenCalledTimes(1);
    expect(fakes.client.release).toHaveBeenCalledWith(false);
  });

  it("discards the client when ROLLBACK itself fails", async () => {
    fakes.client.query.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: [], rowCount: 0 };
    });
    await expect(
      withTransaction(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(fakes.client.release).toHaveBeenCalledWith(true);
  });
});

describe("pool", () => {
  it("is the single pool instance built by the module", () => {
    expect(pool).toBe(fakes.pool);
  });

  it("query() delegates to the pool and marks the db up", async () => {
    const res = await query("SELECT 1", [1]);
    expect(fakes.pool.query).toHaveBeenCalledWith("SELECT 1", [1]);
    expect(res.rows).toEqual([]);
    expect(isDbUp()).toBe(true);
  });

  it("logs pool errors with the message only and marks the db down", async () => {
    const con = silenceConsole();
    const handler = fakes.onError.handler;
    expect(handler).toBeTypeOf("function");
    handler!(new Error("socket closed"));
    expect(con.log.mock.calls[0][0]).toContain("[DB]ERROR: socket closed");
    expect(isDbUp()).toBe(false);
  });
});
