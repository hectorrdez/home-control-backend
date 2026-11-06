import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import aliasStore from "@modules/aliases/AliasStore";
import { deleteAlias, listAliases, setAlias } from "@modules/aliases/AliasesService";
import { InvalidAliasError, InvalidEntityIdError, TooManyAliasesError } from "@modules/aliases/AliasErrors";
import { silenceConsole } from "./helpers";

let dir: string;
let file: string;

beforeEach(() => {
  silenceConsole();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aliases-svc-"));
  file = path.join(dir, "aliases.json");
  aliasStore.load(file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("aliases service", () => {
  it("setAlias stores the normalized alias and returns it", async () => {
    await expect(setAlias("light.a", "  Luz   cocina ")).resolves.toEqual([
      { entityId: "light.a", alias: "Luz cocina" },
    ]);
    expect(listAliases()).toEqual([{ entityId: "light.a", alias: "Luz cocina" }]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).aliases).toEqual({ "light.a": "Luz cocina" });
  });

  it("setAlias replaces an existing alias", async () => {
    await setAlias("light.a", "Uno");
    await setAlias("light.a", "Dos");
    expect(listAliases()).toEqual([{ entityId: "light.a", alias: "Dos" }]);
  });

  it("setAlias with the same value is a no-op write", async () => {
    await setAlias("light.a", "Uno");
    fs.rmSync(file);
    await setAlias("light.a", "Uno");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("setAlias validates the entity id and the alias before touching the store", async () => {
    await expect(setAlias("BAD", "x")).rejects.toBeInstanceOf(InvalidEntityIdError);
    await expect(setAlias("light.a", 3)).rejects.toBeInstanceOf(InvalidAliasError);
    await expect(setAlias("light.a", "  ")).rejects.toBeInstanceOf(InvalidAliasError);
    expect(listAliases()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a new entity once 2000 aliases exist, but still allows updating an existing one", async () => {
    const seeded: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) seeded[`light.e${i}`] = `A${i}`;
    fs.writeFileSync(file, JSON.stringify({ version: 1, aliases: seeded }));
    aliasStore.load(file);

    await expect(setAlias("light.new", "Nuevo")).rejects.toBeInstanceOf(TooManyAliasesError);
    await expect(setAlias("light.e0", "Cambiado")).resolves.toEqual([{ entityId: "light.e0", alias: "Cambiado" }]);
    expect(aliasStore.get("light.e0")).toBe("Cambiado");
  });

  it("deleteAlias removes the alias and always returns an empty array", async () => {
    await setAlias("light.a", "Luz");
    await expect(deleteAlias("light.a")).resolves.toEqual([]);
    expect(listAliases()).toEqual([]);
  });

  it("deleteAlias is idempotent for unknown entities", async () => {
    await expect(deleteAlias("light.nope")).resolves.toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("deleteAlias validates the entity id", async () => {
    await expect(deleteAlias("nope")).rejects.toBeInstanceOf(InvalidEntityIdError);
  });
});
