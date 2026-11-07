import { beforeEach, describe, expect, it } from "vitest";
import { AliasStore } from "@modules/aliases/AliasStore";
import { createFakeDocumentDb, FakeDocumentDb } from "./fake-documents-db";
import { silenceConsole } from "./helpers";

let db: FakeDocumentDb;

beforeEach(() => {
  db = createFakeDocumentDb();
});

describe("AliasStore load", () => {
  it("starts empty when the collection has no rows", async () => {
    const store = new AliasStore(db);
    await store.load();
    expect(store.list()).toEqual([]);
  });

  it("loads rows and lists them sorted by entity id", async () => {
    db.seed("aliases", { "switch.b": "Ventilador", "light.a": "Luz" });
    const store = new AliasStore(db);
    await store.load();
    expect(store.list()).toEqual([
      { entityId: "light.a", alias: "Luz" },
      { entityId: "switch.b", alias: "Ventilador" },
    ]);
    expect(store.get("light.a")).toBe("Luz");
  });

  it("skips invalid rows on load and logs how many were ignored", async () => {
    db.seed("aliases", {
      "light.ok": "Bien",
      "BAD.id": "x",
      "light.empty": "",
      "light.num": 5,
      "light.ctrl": "a\u0001b",
      "light.long": "x".repeat(81),
    });
    const con = silenceConsole();
    const store = new AliasStore(db);
    await store.load();
    expect(store.list()).toEqual([{ entityId: "light.ok", alias: "Bien" }]);
    expect(con.log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("ignored 5 invalid alias entries");
  });

  it("caps the loaded map at 2000 entries", async () => {
    silenceConsole();
    const aliases: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) aliases[`light.e${i}`] = `A${i}`;
    db.seed("aliases", aliases);
    const store = new AliasStore(db);
    await store.load();
    expect(store.list()).toHaveLength(2000);
  });
});

describe("AliasStore mutate", () => {
  it("persists the change through the database", async () => {
    const store = new AliasStore(db);
    await store.load();
    await store.mutate((draft) => {
      draft.set("light.a", "Luz");
      return true;
    });
    expect(db.snapshot("aliases")).toEqual({ "light.a": "Luz" });
    expect(store.get("light.a")).toBe("Luz");
  });
});
