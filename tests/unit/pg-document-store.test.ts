import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDocumentStore, importLegacyJson } from "@shared/PgDocumentStore";
import { createFakeDocumentDb, FakeDocumentDb } from "./fake-documents-db";
import { silenceConsole } from "./helpers";

const isValid = (_key: string, raw: unknown) => (typeof raw === "string" && raw.length > 0 ? raw : undefined);

let db: FakeDocumentDb;
let dir: string;

beforeEach(() => {
  db = createFakeDocumentDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-doc-store-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeStore(overrides: Partial<ConstructorParameters<typeof PgDocumentStore<string>>[0]> = {}) {
  return new PgDocumentStore<string>({
    scope: "TestStore",
    collection: "things",
    legacyProperty: "things",
    entryLabel: "thing",
    max: 100,
    parseEntry: isValid,
    createWriteError: () => new Error("write failed"),
    db,
    ...overrides,
  });
}

const seed = (collection: string, key: string, value: unknown) =>
  db.rows.set(`${collection}\u0000${key}`, { collection, key, value, version: 1, updated_by: null });

const stored = (key: string, collection = "things") => db.rows.get(`${collection}\u0000${key}`);

describe("PgDocumentStore load", () => {
  it("parses rows of its collection only, sorted by key", async () => {
    seed("things", "b", "Two");
    seed("things", "a", "One");
    seed("other", "c", "Other collection");
    const store = makeStore();
    await store.load();
    expect(store.entries()).toEqual([
      ["a", "One"],
      ["b", "Two"],
    ]);
    expect(store.get("a")).toBe("One");
  });

  it("skips invalid rows and rows over max, and logs the count without contents", async () => {
    seed("things", "a", "ok");
    seed("things", "b", 5);
    seed("things", "c", "");
    seed("things", "d", "ok-too");
    const con = silenceConsole();
    const store = makeStore({ max: 2 });
    await store.load();
    expect(store.entries().map(([k]) => k)).toEqual(["a", "d"]);
    const logged = con.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("ignored 2 invalid thing entries on load");
    expect(logged).not.toContain("ok-too");
  });

  it("throws when the database query fails", async () => {
    db.failNext(/FROM documents/);
    await expect(makeStore().load()).rejects.toThrow("injected db failure");
  });
});

describe("PgDocumentStore mutate", () => {
  it("inserts, updates and deletes in one BEGIN/COMMIT and swaps memory after commit", async () => {
    seed("things", "keep", "same");
    seed("things", "gone", "bye");
    seed("things", "edit", "old");
    const store = makeStore();
    await store.load();
    db.statements.length = 0;

    await store.mutate((draft) => {
      draft.set("new", "fresh");
      draft.set("edit", "new");
      draft.delete("gone");
      return true;
    });

    expect(db.statements[0]).toBe("BEGIN");
    expect(db.statements[db.statements.length - 1]).toBe("COMMIT");
    expect(db.statements.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(db.statements.some((s) => s.startsWith("INSERT INTO documents") && s.includes("ON CONFLICT (collection, key)"))).toBe(true);
    expect(db.statements).toContain("DELETE FROM documents WHERE collection = $1 AND key = $2");
    expect(stored("new")?.value).toBe("fresh");
    expect(stored("edit")?.value).toBe("new");
    expect(stored("edit")?.version).toBe(2);
    expect(stored("gone")).toBeUndefined();
    expect(stored("keep")?.version).toBe(1);
    expect(store.entries()).toEqual([
      ["edit", "new"],
      ["keep", "same"],
      ["new", "fresh"],
    ]);
  });

  it("issues no query when change returns false", async () => {
    const store = makeStore();
    await store.load();
    db.statements.length = 0;
    await store.mutate(() => false);
    expect(db.statements).toEqual([]);
  });

  it("issues no query when the value is unchanged", async () => {
    seed("things", "a", "same");
    const store = makeStore();
    await store.load();
    db.statements.length = 0;
    await store.mutate((draft) => {
      draft.set("a", "same");
      return true;
    });
    expect(db.statements).toEqual([]);
  });

  it("rolls back, throws the configured error and restores db and cache when a later statement fails", async () => {
    seed("things", "a", "one");
    const con = silenceConsole();
    const store = makeStore({ createWriteError: () => new Error("configured write error") });
    await store.load();
    db.statements.length = 0;
    db.failNext(/^DELETE FROM documents/); // runs after the INSERT of "b" succeeded
    await expect(
      store.mutate((draft) => {
        draft.set("b", "two");
        draft.delete("a");
        return true;
      })
    ).rejects.toThrow("configured write error");
    expect(db.statements.some((s) => s.startsWith("INSERT INTO documents"))).toBe(true);
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements).not.toContain("COMMIT");
    expect(stored("b")).toBeUndefined();
    expect(stored("a")?.value).toBe("one");
    expect(store.entries()).toEqual([["a", "one"]]);
    expect(con.log.mock.calls.length + con.error.mock.calls.length).toBeGreaterThan(0);
  });

  it("resolves and keeps the commit when onChanged throws, logging only the message", async () => {
    const con = silenceConsole();
    const store = makeStore({
      onChanged: () => {
        throw new Error("observer boom");
      },
    });
    await store.load();
    await expect(
      store.mutate((draft) => {
        draft.set("a", "one");
        return true;
      })
    ).resolves.toBeUndefined();
    expect(stored("a")?.value).toBe("one");
    expect(store.get("a")).toBe("one");
    const logged = [...con.log.mock.calls, ...con.error.mock.calls].map((c) => String(c[0])).join("\n");
    expect(logged).toContain("observer boom");
  });

  it("does not publish anything when the change callback throws", async () => {
    const store = makeStore();
    await store.load();
    await expect(
      store.mutate(() => {
        throw new Error("validation");
      })
    ).rejects.toThrow("validation");
    expect(store.entries()).toEqual([]);
  });

  it("serializes concurrent mutations so the second sees the first's result", async () => {
    const store = makeStore();
    await store.load();
    const first = store.mutate((draft) => {
      draft.set("x", "1");
      return true;
    });
    const second = store.mutate((draft) => {
      expect(draft.get("x")).toBe("1");
      draft.set("x", "2");
      return true;
    });
    await Promise.all([first, second]);
    expect(store.get("x")).toBe("2");
  });

  it("calls onChanged with changed and removed keys only, after commit", async () => {
    seed("things", "keep", "same");
    seed("things", "gone", "bye");
    const onChanged = vi.fn(() => {
      expect(stored("new")).toBeDefined();
    });
    const store = makeStore({ onChanged });
    await store.load();
    await store.mutate((draft) => {
      draft.set("new", "fresh");
      draft.delete("gone");
      return true;
    });
    expect(onChanged).toHaveBeenCalledWith(["new", "gone"]);
  });

  it("stores the by option in updated_by, null by default", async () => {
    const store = makeStore();
    await store.load();
    await store.mutate((draft) => {
      draft.set("a", "1");
      return true;
    }, { by: "client-7" });
    await store.mutate((draft) => {
      draft.set("b", "2");
      return true;
    });
    expect(stored("a")?.updated_by).toBe("client-7");
    expect(stored("b")?.updated_by).toBeNull();
  });
});

describe("importLegacyJson", () => {
  const legacyFile = () => path.join(dir, "things.json");

  it("imports a valid v1 file into an empty collection and renames it", async () => {
    const con = silenceConsole();
    fs.writeFileSync(legacyFile(), JSON.stringify({ version: 1, things: { a: "Uno", b: "Dos" } }));
    const store = makeStore();
    await store.load();
    await importLegacyJson(store, legacyFile());
    expect(store.entries()).toEqual([
      ["a", "Uno"],
      ["b", "Dos"],
    ]);
    expect(stored("a")?.value).toBe("Uno");
    expect(fs.existsSync(legacyFile())).toBe(false);
    const renamed = fs.readdirSync(dir).filter((f) => /^things\.json\.imported-\d+$/.test(f));
    expect(renamed).toHaveLength(1);
    expect(con.log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("imported 2 thing entries from things.json");
  });

  it("skips the import when the collection already has rows, leaving the file in place", async () => {
    seed("things", "existing", "keep");
    fs.writeFileSync(legacyFile(), JSON.stringify({ version: 1, things: { a: "Uno" } }));
    silenceConsole();
    const store = makeStore();
    await store.load();
    await importLegacyJson(store, legacyFile());
    expect(stored("a")).toBeUndefined();
    expect(fs.existsSync(legacyFile())).toBe(true);
  });

  it("does nothing when the file is missing", async () => {
    const store = makeStore();
    await store.load();
    await importLegacyJson(store, legacyFile());
    expect(db.statements.filter((s) => s.startsWith("INSERT"))).toEqual([]);
  });

  it("quarantines a corrupt file and imports nothing", async () => {
    silenceConsole();
    fs.writeFileSync(legacyFile(), "{ not json");
    const store = makeStore();
    await store.load();
    await importLegacyJson(store, legacyFile());
    expect(store.entries()).toEqual([]);
    expect(fs.existsSync(legacyFile())).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("things.json.corrupt-"))).toBe(true);
    expect(db.statements.filter((s) => s.startsWith("INSERT"))).toEqual([]);
  });

  it("keeps the file in place when the database write fails", async () => {
    silenceConsole();
    fs.writeFileSync(legacyFile(), JSON.stringify({ version: 1, things: { a: "Uno" } }));
    const store = makeStore();
    await store.load();
    db.failNext(/^INSERT INTO documents/);
    await importLegacyJson(store, legacyFile());
    expect(fs.existsSync(legacyFile())).toBe(true);
    expect(store.entries()).toEqual([]);
    expect(stored("a")).toBeUndefined();
  });

  it("leaves nothing behind when a later entry of a multi-entry import fails", async () => {
    silenceConsole();
    fs.writeFileSync(legacyFile(), JSON.stringify({ version: 1, things: { a: "Uno", b: "Dos", c: "Tres" } }));
    const store = makeStore();
    await store.load();
    const realQuery = db.query.bind(db);
    let inserts = 0;
    vi.spyOn(db, "query").mockImplementation(async (sql, params) => {
      if (/^\s*INSERT INTO documents/.test(sql) && ++inserts === 2) throw new Error("injected db failure");
      return realQuery(sql, params);
    });
    await importLegacyJson(store, legacyFile());
    expect(inserts).toBe(2);
    expect(db.statements).toContain("ROLLBACK");
    expect(db.snapshot("things")).toEqual({});
    expect(store.entries()).toEqual([]);
    expect(fs.existsSync(legacyFile())).toBe(true);
  });
});
