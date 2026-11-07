import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import alertRuleStore from "@modules/alert-rules/AlertRuleStore";
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  replaceAlertRule,
} from "@modules/alert-rules/AlertRulesService";
import {
  DuplicateRuleError,
  InvalidRuleError,
  RuleNotFoundError,
  TooManyRulesError,
} from "@modules/alert-rules/AlertRuleErrors";
import { InvalidEntityIdError } from "@modules/entities/EntityErrors";
import { silenceConsole } from "./helpers";

let dir: string;
let file: string;

const body = (over: Record<string, unknown> = {}) => ({
  entityId: "light.kitchen",
  trigger: { type: "connects" },
  level: "high",
  ...over,
});

beforeEach(() => {
  silenceConsole();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-svc-"));
  file = path.join(dir, "alert-rules.json");
  alertRuleStore.load(file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("alert rules service", () => {
  it("createAlertRule generates a uuid id and stores the rule", async () => {
    const [rule] = await createAlertRule(body({ message: "Door opened" }));
    expect(rule.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rule).toMatchObject({ entityId: "light.kitchen", trigger: { type: "connects" }, level: "high" });
    expect(listAlertRules()).toEqual([rule]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).rules[rule.id].message).toBe("Door opened");
  });

  it("createAlertRule ignores an id sent in the body", async () => {
    const [rule] = await createAlertRule(body({ id: "client-id" }));
    expect(rule.id).not.toBe("client-id");
  });

  it("createAlertRule rejects invalid bodies before touching the store", async () => {
    await expect(createAlertRule(body({ entityId: "BAD" }))).rejects.toBeInstanceOf(InvalidEntityIdError);
    await expect(createAlertRule(body({ level: "x" }))).rejects.toBeInstanceOf(InvalidRuleError);
    await expect(createAlertRule(undefined)).rejects.toBeInstanceOf(InvalidRuleError);
    expect(listAlertRules()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("createAlertRule refuses a second rule with the same entity and trigger, and allows another value", async () => {
    await createAlertRule(body());
    await expect(createAlertRule(body({ level: "low" }))).rejects.toBeInstanceOf(DuplicateRuleError);
    await expect(createAlertRule(body({ trigger: { type: "above", value: 5 } }))).resolves.toHaveLength(1);
    await expect(createAlertRule(body({ trigger: { type: "above", value: 6 } }))).resolves.toHaveLength(1);
    await expect(createAlertRule(body({ trigger: { type: "above", value: 5 } }))).rejects.toBeInstanceOf(
      DuplicateRuleError
    );
  });

  it("listAlertRules filters by entity and validates the filter", async () => {
    await createAlertRule(body());
    await createAlertRule(body({ entityId: "switch.lamp", trigger: { type: "disconnects" } }));
    expect(listAlertRules("switch.lamp").map((r) => r.entityId)).toEqual(["switch.lamp"]);
    expect(listAlertRules("light.none")).toEqual([]);
    expect(listAlertRules()).toHaveLength(2);
    expect(() => listAlertRules("BAD")).toThrow(InvalidEntityIdError);
  });

  it("listAlertRules sorts by entity id then id", async () => {
    await createAlertRule(body({ entityId: "switch.b", trigger: { type: "connects" } }));
    await createAlertRule(body({ entityId: "switch.a", trigger: { type: "connects" } }));
    expect(listAlertRules().map((r) => r.entityId)).toEqual(["switch.a", "switch.b"]);
  });

  it("replaceAlertRule keeps the id and swaps the fields", async () => {
    const [created] = await createAlertRule(body());
    const [replaced] = await replaceAlertRule(created.id, body({ trigger: { type: "state_becomes", value: "on" } }));
    expect(replaced).toMatchObject({ id: created.id, trigger: { type: "state_becomes", value: "on" } });
    expect(listAlertRules()).toEqual([replaced]);
  });

  it("replaceAlertRule to its own trigger is not a duplicate of itself", async () => {
    const [created] = await createAlertRule(body());
    await expect(replaceAlertRule(created.id, body({ level: "low" }))).resolves.toMatchObject([{ level: "low" }]);
  });

  it("replaceAlertRule rejects unknown ids, invalid bodies and duplicates", async () => {
    const [a] = await createAlertRule(body());
    const [b] = await createAlertRule(body({ trigger: { type: "interacted" } }));
    await expect(replaceAlertRule(randomUUID(), body())).rejects.toBeInstanceOf(RuleNotFoundError);
    await expect(replaceAlertRule(a.id, body({ trigger: { type: "bogus" } }))).rejects.toBeInstanceOf(InvalidRuleError);
    await expect(replaceAlertRule(a.id, body({ entityId: "BAD" }))).rejects.toBeInstanceOf(InvalidEntityIdError);
    await expect(replaceAlertRule(b.id, body())).rejects.toBeInstanceOf(DuplicateRuleError);
    expect(listAlertRules().map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("deleteAlertRule removes the rule and is idempotent", async () => {
    const [created] = await createAlertRule(body());
    await expect(deleteAlertRule(created.id)).resolves.toEqual([]);
    expect(listAlertRules()).toEqual([]);
    await expect(deleteAlertRule(created.id)).resolves.toEqual([]);
  });

  it("refuses a rule beyond 500 but still allows replacing one", async () => {
    const seeded: Record<string, unknown> = {};
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      const id = randomUUID();
      ids.push(id);
      seeded[id] = { entityId: `light.l${i}`, trigger: { type: "connects" }, level: "low" };
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, rules: seeded }));
    alertRuleStore.load(file);

    await expect(createAlertRule(body({ entityId: "light.new" }))).rejects.toBeInstanceOf(TooManyRulesError);
    await expect(replaceAlertRule(ids[0], body({ entityId: "light.l0", level: "off" }))).resolves.toHaveLength(1);
  });
});
