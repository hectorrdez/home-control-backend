import { describe, expect, it } from "vitest";
import { parseEventQuery } from "@modules/events/EventQuery";
import { InvalidQueryError } from "@modules/events/EventErrors";

const bad = (query: Record<string, unknown>) => {
  try {
    parseEventQuery(query);
  } catch (err) {
    return err;
  }
  throw new Error("expected invalid_query");
};

describe("parseEventQuery defaults", () => {
  it("uses limit 100 and no filters when empty", () => {
    expect(parseEventQuery({})).toEqual({ limit: 100 });
  });

  it("splits a comma list of types", () => {
    expect(parseEventQuery({ types: "action,config_changed" })).toEqual({
      limit: 100,
      types: ["action", "config_changed"],
    });
  });

  it("accepts up to 10 types", () => {
    const types = Array.from({ length: 10 }, (_, i) => `type${"abcdefghij"[i]}`).join(",").replace(/\d/g, "");
    expect(parseEventQuery({ types }).types).toHaveLength(10);
  });
});

describe("parseEventQuery invalid params", () => {
  it.each([
    ["types with uppercase", { types: "Bad-Type" }],
    ["types with an empty item", { types: "action," }],
    ["types with 11 items", { types: Array.from({ length: 11 }, (_, i) => `t${i}`).join(",") }],
    ["repeated types", { types: ["action", "action"] }],
    ["empty types", { types: "" }],
    ["entityId without domain", { entityId: "light" }],
    ["entityId uppercase", { entityId: "Light.salon" }],
    ["from not a date", { from: "nope" }],
    ["from impossible day", { from: "2026-02-30T00:00:00Z" }],
    ["from hour 25", { from: "2026-11-08T25:00:00Z" }],
    ["from without timezone", { from: "2026-11-08T10:00:00" }],
    ["to not a date", { to: "tomorrow" }],
    ["from after to", { from: "2026-11-09T00:00:00Z", to: "2026-11-08T00:00:00Z" }],
    ["before not digits", { before: "abc" }],
    ["before negative", { before: "-1" }],
    ["before beyond bigint", { before: "9223372036854775808" }],
    ["limit zero", { limit: "0" }],
    ["limit 501", { limit: "501" }],
    ["limit not a number", { limit: "ten" }],
    ["limit fractional", { limit: "1.5" }],
  ])("rejects %s with invalid_query", (_label, query) => {
    const err = bad(query);
    expect(err).toBeInstanceOf(InvalidQueryError);
    expect((err as InvalidQueryError).getErrorCode()).toBe("invalid_query");
    expect((err as InvalidQueryError).getCode()).toBe(400);
  });

  it("names the offending parameter in the message", () => {
    expect((bad({ before: "abc" }) as InvalidQueryError).getMessage()).toContain("before");
    expect((bad({ limit: "501" }) as InvalidQueryError).getMessage()).toContain("limit");
  });
});

describe("parseEventQuery valid params", () => {
  it("accepts an entityId, a date-only range and a cursor", () => {
    expect(
      parseEventQuery({ entityId: "light.salon", from: "2026-11-01", to: "2026-11-08", before: "120" })
    ).toEqual({ limit: 100, entityId: "light.salon", from: "2026-11-01", to: "2026-11-08", before: "120" });
  });

  it("accepts ISO instants with fractions and offsets", () => {
    expect(parseEventQuery({ from: "2026-11-01T10:00:00.123+02:00", to: "2026-11-01T12:00:00Z" }).from).toBe(
      "2026-11-01T10:00:00.123+02:00"
    );
  });

  it("accepts limit bounds 1 and 500", () => {
    expect(parseEventQuery({ limit: "1" }).limit).toBe(1);
    expect(parseEventQuery({ limit: "500" }).limit).toBe(500);
  });

  it("accepts a cursor at the bigint maximum", () => {
    expect(parseEventQuery({ before: "9223372036854775807" }).before).toBe("9223372036854775807");
  });

  it("allows from equal to to", () => {
    expect(() => parseEventQuery({ from: "2026-11-08T00:00:00Z", to: "2026-11-08T00:00:00Z" })).not.toThrow();
  });
});
