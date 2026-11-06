import { describe, expect, it } from "vitest";
import {
  isValidAlias,
  isValidEntityId,
  MAX_ALIASES,
  normalizeAlias,
  parseAlias,
  parseEntityId,
} from "@modules/aliases/AliasValidation";
import { InvalidAliasError, InvalidEntityIdError } from "@modules/aliases/AliasErrors";

describe("alias validation", () => {
  it("exposes the 2000 alias cap", () => {
    expect(MAX_ALIASES).toBe(2000);
  });

  it("validates entity ids with the shared regex", () => {
    expect(isValidEntityId("light.kitchen_1")).toBe(true);
    expect(isValidEntityId("light.Kitchen")).toBe(false);
    expect(isValidEntityId("light")).toBe(false);
    expect(parseEntityId("switch.fan")).toBe("switch.fan");
    expect(() => parseEntityId("nope")).toThrow(InvalidEntityIdError);
  });

  it("trims and collapses every whitespace run, tabs and newlines included", () => {
    expect(normalizeAlias("  Luz \t del\n  salon  ")).toBe("Luz del salon");
    expect(normalizeAlias(" \n\t ")).toBe("");
  });

  it("accepts 1..80 code points and counts astral characters as one", () => {
    expect(isValidAlias("a")).toBe(true);
    expect(isValidAlias("a".repeat(80))).toBe(true);
    expect(isValidAlias("a".repeat(81))).toBe(false);
    expect(isValidAlias("😀".repeat(80))).toBe(true);
    expect(isValidAlias("😀".repeat(81))).toBe(false);
    expect(isValidAlias("")).toBe(false);
  });

  it("rejects C0, DEL and C1 control characters", () => {
    for (const bad of ["a\u0000b", "a\u001Fb", "a\u007Fb", "a\u0085b", "a\u009Fb"]) {
      expect(isValidAlias(bad)).toBe(false);
    }
  });

  it("parseAlias returns the normalized value and rejects non-strings and empties", () => {
    expect(parseAlias("  Sofá   gris ")).toBe("Sofá gris");
    expect(() => parseAlias(undefined)).toThrow(InvalidAliasError);
    expect(() => parseAlias(12)).toThrow(InvalidAliasError);
    expect(() => parseAlias({ a: 1 })).toThrow(InvalidAliasError);
    expect(() => parseAlias("   ")).toThrow(InvalidAliasError);
    expect(() => parseAlias("x".repeat(81))).toThrow(InvalidAliasError);
  });
});
