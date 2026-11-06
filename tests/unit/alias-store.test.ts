import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AliasStore } from "@modules/aliases/AliasStore";
import { AliasWriteFailedError } from "@modules/aliases/AliasErrors";
import { silenceConsole } from "./helpers";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alias-store-"));
  file = path.join(dir, "nested", "aliases.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const readJson = () => JSON.parse(fs.readFileSync(file, "utf8"));
const logText = (con: { log: ReturnType<typeof vi.spyOn> }) =>
  con.log.mock.calls.map((c) => String(c[0])).join("\n");

describe("AliasStore load", () => {
  it("starts empty when the file does not exist yet", () => {
    const store = new AliasStore();
    store.load(file);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("loads a valid file and lists entries sorted by entity id", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, aliases: { "switch.b": "Ventilador", "light.a": "Luz" } }));
    const store = new AliasStore();
    store.load(file);
    expect(store.list()).toEqual([
      { entityId: "light.a", alias: "Luz" },
      { entityId: "switch.b", alias: "Ventilador" },
    ]);
    expect(store.get("light.a")).toBe("Luz");
    expect(store.get("light.zzz")).toBeUndefined();
  });

  it("skips invalid entries on load and logs how many were ignored", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const con = silenceConsole();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        aliases: {
          "light.ok": "Bien",
          "BAD.id": "x",
          "light.empty": "",
          "light.num": 5,
          "light.ctrl": "a\u0001b",
          "light.long": "x".repeat(81),
        },
      })
    );
    const store = new AliasStore();
    store.load(file);
    expect(store.list()).toEqual([{ entityId: "light.ok", alias: "Bien" }]);
    expect(logText(con)).toContain("ignored 5 invalid alias entries");
  });

  it("caps the loaded map at 2000 entries", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    silenceConsole();
    const aliases: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) aliases[`light.e${i}`] = `A${i}`;
    fs.writeFileSync(file, JSON.stringify({ version: 1, aliases }));
    const store = new AliasStore();
    store.load(file);
    expect(store.list()).toHaveLength(2000);
  });

  it("moves an unparseable file aside and starts empty", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    silenceConsole();
    fs.writeFileSync(file, "{not json");
    const store = new AliasStore();
    store.load(file);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    const moved = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith("aliases.json.corrupt-"));
    expect(moved).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), moved[0]), "utf8")).toBe("{not json");
  });

  it("moves a file with the wrong version or a non-object aliases field aside", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    silenceConsole();
    for (const body of [
      JSON.stringify({ version: 2, aliases: {} }),
      JSON.stringify({ version: 1, aliases: [] }),
      JSON.stringify({ version: 1 }),
      "null",
    ]) {
      fs.writeFileSync(file, body);
      const store = new AliasStore();
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
    const store = new AliasStore();
    expect(() => store.load(file)).not.toThrow();
    expect(store.list()).toEqual([]);
    expect(logText(con)).toContain("could not move it aside");
  });
});

describe("AliasStore mutate", () => {
  it("persists a sorted, versioned file atomically and leaves no tmp file behind", async () => {
    const store = new AliasStore();
    store.load(file);
    await store.mutate((d) => {
      d.set("switch.b", "Ventilador");
      d.set("light.a", "Luz");
      return true;
    });
    expect(readJson()).toEqual({ version: 1, aliases: { "light.a": "Luz", "switch.b": "Ventilador" } });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(store.list()).toEqual([
      { entityId: "light.a", alias: "Luz" },
      { entityId: "switch.b", alias: "Ventilador" },
    ]);
  });

  it("does not write when the change reports no modification", async () => {
    const store = new AliasStore();
    store.load(file);
    await store.mutate(() => false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("publishes nothing when the change callback throws", async () => {
    const store = new AliasStore();
    store.load(file);
    await store.mutate((d) => {
      d.set("light.a", "Luz");
      return true;
    });
    await expect(
      store.mutate((d) => {
        d.set("light.b", "Otra");
        throw new Error("validation");
      })
    ).rejects.toThrow("validation");
    expect(store.get("light.b")).toBeUndefined();
    expect(readJson().aliases).toEqual({ "light.a": "Luz" });
  });

  it("serializes concurrent mutations so none are lost", async () => {
    const store = new AliasStore();
    store.load(file);
    const set = (id: string) =>
      store.mutate((d) => {
        d.set(id, id);
        return true;
      });
    await Promise.all([set("light.a"), set("light.b"), set("light.c")]);
    expect(store.list().map((e) => e.entityId)).toEqual(["light.a", "light.b", "light.c"]);
    expect(Object.keys(readJson().aliases)).toHaveLength(3);
  });

  it("keeps memory unchanged and removes the tmp file when the write fails", async () => {
    const store = new AliasStore();
    store.load(file);
    silenceConsole();
    await store.mutate((d) => {
      d.set("light.a", "Luz");
      return true;
    });

    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("disk full"));
    const err = await store
      .mutate((d) => {
        d.set("light.a", "Nueva");
        return true;
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AliasWriteFailedError);
    expect(err.getCode()).toBe(500);
    expect(store.get("light.a")).toBe("Luz");
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(readJson().aliases).toEqual({ "light.a": "Luz" });
  });

  it("keeps working after a failed write", async () => {
    const store = new AliasStore();
    store.load(file);
    silenceConsole();
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("boom"));
    await expect(
      store.mutate((d) => {
        d.set("light.a", "X");
        return true;
      })
    ).rejects.toBeInstanceOf(AliasWriteFailedError);
    await store.mutate((d) => {
      d.set("light.b", "Y");
      return true;
    });
    expect(store.list()).toEqual([{ entityId: "light.b", alias: "Y" }]);
  });
});
