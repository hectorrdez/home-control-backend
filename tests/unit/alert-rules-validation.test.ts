import { describe, expect, it } from "vitest";
import {
  ALERT_LEVELS,
  MAX_ALERT_RULES,
  parseEntityIdFilter,
  parseRuleBody,
  readRuleFields,
  triggerKey,
} from "@modules/alert-rules/AlertRuleValidation";
import { InvalidRuleError } from "@modules/alert-rules/AlertRuleErrors";
import { InvalidEntityIdError } from "@modules/entities/EntityErrors";

const base = { entityId: "light.kitchen", trigger: { type: "connects" }, level: "high" };

describe("alert rule fields", () => {
  it("exposes the 500 rule cap and the four levels", () => {
    expect(MAX_ALERT_RULES).toBe(500);
    expect([...ALERT_LEVELS]).toEqual(["off", "low", "medium", "high"]);
  });

  it("accepts every trigger type with its value rules", () => {
    expect(readRuleFields(base)).toEqual({ entityId: "light.kitchen", trigger: { type: "connects" }, level: "high" });
    expect(readRuleFields({ ...base, trigger: { type: "disconnects" } })?.trigger).toEqual({ type: "disconnects" });
    expect(readRuleFields({ ...base, trigger: { type: "interacted" } })?.trigger).toEqual({ type: "interacted" });
    expect(readRuleFields({ ...base, trigger: { type: "state_becomes", value: "on" } })?.trigger).toEqual({
      type: "state_becomes",
      value: "on",
    });
    expect(readRuleFields({ ...base, trigger: { type: "above", value: -3.5 } })?.trigger).toEqual({
      type: "above",
      value: -3.5,
    });
    expect(readRuleFields({ ...base, trigger: { type: "below", value: 0 } })?.trigger).toEqual({
      type: "below",
      value: 0,
    });
  });

  it("drops extra trigger fields and keeps the message when present", () => {
    const fields = readRuleFields({ ...base, trigger: { type: "connects", value: 9 }, message: "Lights on" });
    expect(fields).toEqual({
      entityId: "light.kitchen",
      trigger: { type: "connects" },
      level: "high",
      message: "Lights on",
    });
  });

  it("rejects bad entity ids, triggers, levels and messages", () => {
    expect(readRuleFields(null)).toBeUndefined();
    expect(readRuleFields("rule")).toBeUndefined();
    expect(readRuleFields({ ...base, entityId: "BAD" })).toBeUndefined();
    expect(readRuleFields({ ...base, entityId: 5 })).toBeUndefined();
    expect(readRuleFields({ ...base, trigger: null })).toBeUndefined();
    expect(readRuleFields({ ...base, trigger: "connects" })).toBeUndefined();
    expect(readRuleFields({ ...base, trigger: { type: "bogus" } })).toBeUndefined();
    expect(readRuleFields({ ...base, trigger: { type: "state_becomes", value: "" } })).toBeUndefined();
    expect(readRuleFields({ ...base, trigger: { type: "state_becomes", value: "x".repeat(41) } })).toBeUndefined();
    expect(readRuleFields({ ...base, trigger: { type: "state_becomes", value: 3 } })).toBeUndefined();
    expect(readRuleFields({ ...base, trigger: { type: "above", value: "3" } })).toBeUndefined();
    expect(readRuleFields({ ...base, trigger: { type: "below", value: Number.NaN } })).toBeUndefined();
    expect(readRuleFields({ ...base, level: "critical" })).toBeUndefined();
    expect(readRuleFields({ ...base, level: undefined })).toBeUndefined();
    expect(readRuleFields({ ...base, message: "" })).toBeUndefined();
    expect(readRuleFields({ ...base, message: "x".repeat(121) })).toBeUndefined();
    expect(readRuleFields({ ...base, message: 7 })).toBeUndefined();
  });

  it("accepts the length boundaries for state and message", () => {
    expect(readRuleFields({ ...base, trigger: { type: "state_becomes", value: "x".repeat(40) } })).toBeDefined();
    expect(readRuleFields({ ...base, message: "x".repeat(120) })).toBeDefined();
  });
});

describe("parseRuleBody", () => {
  it("returns the fields for a valid body", () => {
    expect(parseRuleBody(base)).toMatchObject({ entityId: "light.kitchen", level: "high" });
  });

  it("throws invalid_rule for a non-object body", () => {
    expect(() => parseRuleBody(undefined)).toThrow(InvalidRuleError);
    expect(() => parseRuleBody("x")).toThrow(InvalidRuleError);
  });

  it("throws invalid_entity_id for a missing or malformed entity id", () => {
    expect(() => parseRuleBody({ ...base, entityId: undefined })).toThrow(InvalidEntityIdError);
    expect(() => parseRuleBody({ ...base, entityId: "Light.x" })).toThrow(InvalidEntityIdError);
  });

  it("throws invalid_rule for any other bad field", () => {
    expect(() => parseRuleBody({ ...base, level: "nope" })).toThrow(InvalidRuleError);
  });
});

describe("entity filter and duplicate identity", () => {
  it("validates the ?entityId= filter with the entity id regex", () => {
    expect(parseEntityIdFilter("switch.lamp")).toBe("switch.lamp");
    expect(() => parseEntityIdFilter("BAD")).toThrow(InvalidEntityIdError);
  });

  it("uses entity, trigger type and value as the duplicate identity", () => {
    const connects = triggerKey({ entityId: "a.b", trigger: { type: "connects" }, level: "low" });
    expect(triggerKey({ entityId: "a.b", trigger: { type: "connects" }, level: "high", message: "x" })).toBe(connects);
    expect(triggerKey({ entityId: "a.c", trigger: { type: "connects" }, level: "low" })).not.toBe(connects);
    expect(triggerKey({ entityId: "a.b", trigger: { type: "above", value: 1 }, level: "low" })).not.toBe(
      triggerKey({ entityId: "a.b", trigger: { type: "above", value: 2 }, level: "low" })
    );
    expect(triggerKey({ entityId: "a.b", trigger: { type: "state_becomes", value: "on" }, level: "low" })).not.toBe(
      triggerKey({ entityId: "a.b", trigger: { type: "state_becomes", value: "off" }, level: "low" })
    );
  });
});
