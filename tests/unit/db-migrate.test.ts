import { beforeEach, describe, expect, it, vi } from "vitest";
import { silenceConsole } from "./helpers";

const state = vi.hoisted(() => ({
  migrations: [] as Array<{ version: number; name: string; up: string }>,
  failUp: null as string | null,
}));

vi.mock("../../src/db/migrations", () => ({
  get migrations() {
    return state.migrations;
  },
}));

import { migrate, MIGRATION_LOCK_ID } from "../../src/db/migrate";

/** Fake session: records every statement and tracks schema_migrations in memory. */
function fakeDb() {
  const sql: string[] = [];
  const applied = new Set<number>();
  return {
    sql,
    applied,
    query: vi.fn(async (text: string, params?: unknown[]) => {
      sql.push(text);
      if (state.failUp !== null && text === state.failUp) throw new Error("syntax error at or near");
      if (text.includes("COALESCE(MAX(version)")) {
        const max = applied.size ? Math.max(...applied) : 0;
        return { rows: [{ max }], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO schema_migrations")) applied.add(params![0] as number);
      return { rows: [], rowCount: 0 };
    }),
  };
}

beforeEach(() => {
  state.migrations = [
    { version: 1, name: "one", up: "UP ONE" },
    { version: 2, name: "two", up: "UP TWO" },
    { version: 3, name: "three", up: "UP THREE" },
  ];
  state.failUp = null;
});

describe("migrate", () => {
  it("applies pending migrations in version order, each inside BEGIN/COMMIT, and records them", async () => {
    silenceConsole();
    const db = fakeDb();
    await migrate(db);
    const begins = db.sql.map((s, i) => (s === "BEGIN" ? i : -1)).filter((i) => i >= 0);
    const commits = db.sql.map((s, i) => (s === "COMMIT" ? i : -1)).filter((i) => i >= 0);
    const ups = ["UP ONE", "UP TWO", "UP THREE"].map((s) => db.sql.indexOf(s));
    expect(begins).toHaveLength(3);
    expect(commits).toHaveLength(3);
    ups.forEach((at, n) => {
      expect(begins[n]).toBeLessThan(at);
      expect(commits[n]).toBeGreaterThan(at);
    });
    expect([...db.applied]).toEqual([1, 2, 3]);
  });

  it("applies nothing on a second run", async () => {
    silenceConsole();
    const db = fakeDb();
    await migrate(db);
    db.sql.length = 0;
    await migrate(db);
    expect(db.sql).not.toContain("BEGIN");
    expect(db.sql.some((s) => s.startsWith("INSERT INTO schema_migrations"))).toBe(false);
    expect([...db.applied]).toEqual([1, 2, 3]);
  });

  it("rolls back a failing migration, logs it, throws, and skips the later ones", async () => {
    const con = silenceConsole();
    const db = fakeDb();
    state.failUp = "UP TWO";
    await expect(migrate(db)).rejects.toThrow("syntax error");
    expect(db.sql).toContain("ROLLBACK");
    expect(db.sql).not.toContain("UP THREE");
    expect([...db.applied]).toEqual([1]);
    expect(con.log.mock.calls.map((c) => c[0]).join("\n")).toContain("migration 2 two failed");
  });

  it("takes the advisory lock first and releases it, also when a migration fails", async () => {
    silenceConsole();
    const db = fakeDb();
    state.failUp = "UP ONE";
    await expect(migrate(db)).rejects.toThrow();
    expect(db.query).toHaveBeenNthCalledWith(1, "SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    expect(db.query).toHaveBeenLastCalledWith("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
  });

  it("with a Pool, holds one client for the whole run and releases it", async () => {
    silenceConsole();
    const client = fakeDb();
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query: client.query, release })),
      query: vi.fn(),
    };
    await migrate(pool as any);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect([...client.applied]).toEqual([1, 2, 3]);
  });
});
