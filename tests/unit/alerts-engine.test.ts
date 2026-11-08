import { describe, expect, it } from "vitest";
import { evaluate, fires, isUnavailable, takeFirings, triggerLabel, DEDUPE_MS, EntityLike, AlertEvent } from "@modules/alerts/engine";
import type { AlertRule } from "@modules/alert-rules/AlertRuleStore";

const ent = (over: Partial<EntityLike> = {}): EntityLike => ({
  entityId: "sensor.t",
  domain: "sensor",
  state: "10",
  attributes: { unit_of_measurement: "°C" },
  lastChanged: "2026-01-01T00:00:00.000Z",
  ...over,
});
const NO = { interacted: false };
const YES = { interacted: true };

describe("alert engine parity with the frontend", () => {
  it.each([
    ["connects", "light", "unavailable", "on", { type: "connects" as const }, true],
    ["connects stays down", "light", "unavailable", "unavailable", { type: "connects" as const }, false],
    ["disconnects", "light", "on", "unavailable", { type: "disconnects" as const }, true],
    ["unknown light counts as down", "light", "on", "unknown", { type: "disconnects" as const }, true],
    ["unknown cover is not down", "cover", "open", "unknown", { type: "disconnects" as const }, false],
    ["becomes on", "light", "off", "on", { type: "state_becomes" as const, value: "on" }, true],
    ["already on, no fire", "light", "on", "on", { type: "state_becomes" as const, value: "on" }, false],
  ])("%s", (_name, domain, from, to, trigger, expected) => {
    expect(fires(trigger, ent({ domain, state: from }), ent({ domain, state: to }), NO)).toBe(expected);
  });

  it("above fires on a crossing only and re-arms when the value comes back", () => {
    const t = { type: "above" as const, value: 20 };
    expect(fires(t, ent({ state: "19" }), ent({ state: "21" }), NO)).toBe(true);
    expect(fires(t, ent({ state: "21" }), ent({ state: "22" }), NO)).toBe(false);
    expect(fires(t, ent({ state: "21" }), ent({ state: "19" }), NO)).toBe(false);
    expect(fires(t, ent({ state: "19" }), ent({ state: "21" }), NO)).toBe(true);
    expect(fires(t, ent({ state: "20" }), ent({ state: "25" }), NO)).toBe(true);
  });

  it("below fires on a downward crossing and ignores non-numeric states", () => {
    const t = { type: "below" as const, value: 10 };
    expect(fires(t, ent({ state: "11" }), ent({ state: "9" }), NO)).toBe(true);
    expect(fires(t, ent({ state: "9" }), ent({ state: "8" }), NO)).toBe(false);
    expect(fires(t, ent({ state: "unknown" }), ent({ state: "9" }), NO)).toBe(false);
    expect(fires(t, ent({ state: "" }), ent({ state: "9" }), NO)).toBe(false);
  });

  it("interacted follows the context flag only", () => {
    expect(fires({ type: "interacted" }, ent(), ent(), YES)).toBe(true);
    expect(fires({ type: "interacted" }, ent(), ent(), NO)).toBe(false);
  });

  it("isUnavailable treats unknown as down outside cover/scene/script", () => {
    expect(isUnavailable(ent({ domain: "light", state: "unknown" }))).toBe(true);
    expect(isUnavailable(ent({ domain: "scene", state: "unknown" }))).toBe(false);
    expect(isUnavailable(ent({ domain: "light", state: "unavailable" }))).toBe(true);
  });

  it("default text is the trigger label with the unit", () => {
    expect(triggerLabel({ type: "above", value: 20 }, "°C")).toBe("ABOVE 20 °C");
    expect(triggerLabel({ type: "state_becomes", value: "on" })).toBe("BECOMES ON");
    expect(triggerLabel({ type: "interacted" })).toBe("USER INTERACTS");
  });
});

describe("evaluate and dedupe", () => {
  const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
    id: "11111111-1111-4111-8111-111111111111",
    entityId: "sensor.t",
    trigger: { type: "above", value: 20 },
    level: "high",
    ...over,
  });

  it("off never fires, other entities never fire, message overrides the label", () => {
    const before = ent({ state: "19" });
    const after = ent({ state: "21" });
    expect(evaluate([rule({ level: "off" })], before, after, NO)).toEqual([]);
    expect(evaluate([rule({ entityId: "sensor.other" })], before, after, NO)).toEqual([]);
    const [hit] = evaluate([rule({ message: "Hot" })], before, after, NO);
    expect(hit.text).toBe("Hot");
    expect(hit.level).toBe("high");
    expect(evaluate([rule()], before, after, NO)[0].text).toBe("ABOVE 20 °C");
  });

  it("dedupes the same rule within DEDUPE_MS and keeps it after the window", () => {
    const events = evaluate([rule()], ent({ state: "19" }), ent({ state: "21" }), NO) as AlertEvent[];
    const lastFired = new Map<string, number>();
    expect(takeFirings(events, lastFired, 1000)).toHaveLength(1);
    expect(takeFirings(events, lastFired, 1000 + DEDUPE_MS - 1)).toHaveLength(0);
    expect(takeFirings(events, lastFired, 1000 + DEDUPE_MS)).toHaveLength(1);
  });
});
