import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import alertRuleStore from "@modules/alert-rules/AlertRuleStore";
import AlertRulesController from "@modules/alert-rules/AlertRulesController";
import alertRulesRoutes from "@modules/alert-rules/alert-rules.routes";
import { fakeRes, silenceConsole } from "./helpers";

let dir: string;
let file: string;

beforeEach(() => {
  silenceConsole();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-ctrl-"));
  file = path.join(dir, "alert-rules.json");
  alertRuleStore.load(file);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const rule = { entityId: "light.kitchen", trigger: { type: "connects" }, level: "high" };
const post = (b: unknown) => ({ body: b, params: {}, query: {} }) as any;

describe("AlertRulesController", () => {
  it("create stores the rule and responds with the created rule in data", async () => {
    const res = fakeRes();
    await AlertRulesController.create(post(rule), res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ entityId: "light.kitchen", level: "high" });
    expect(alertRuleStore.list()).toHaveLength(1);
  });

  it("create maps a duplicate to a 409 envelope", async () => {
    await AlertRulesController.create(post(rule), fakeRes() as any);
    const res = fakeRes();
    await AlertRulesController.create(post(rule), res as any);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe("duplicate_rule");
  });

  it("list returns all rules, or only the ?entityId= matches", async () => {
    await AlertRulesController.create(post(rule), fakeRes() as any);
    const all = fakeRes();
    await AlertRulesController.list({ query: {} } as any, all as any);
    expect(all.body.data).toHaveLength(1);
    const filtered = fakeRes();
    await AlertRulesController.list({ query: { entityId: "switch.none" } } as any, filtered as any);
    expect(filtered.body.data).toEqual([]);
    const bad = fakeRes();
    await AlertRulesController.list({ query: { entityId: "BAD" } } as any, bad as any);
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toBe("invalid_entity_id");
  });

  it("replace updates the rule by id and reports unknown ids with 404", async () => {
    const created = fakeRes();
    await AlertRulesController.create(post(rule), created as any);
    const id = created.body.data[0].id;
    const res = fakeRes();
    await AlertRulesController.replace(
      { params: { id }, body: { ...rule, level: "low" }, query: {} } as any,
      res as any
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.data[0]).toMatchObject({ id, level: "low" });

    const missing = fakeRes();
    await AlertRulesController.replace(
      { params: { id: "missing" }, body: rule, query: {} } as any,
      missing as any
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.body.error).toBe("rule_not_found");
  });

  it("delete removes the rule and responds with an empty array", async () => {
    const created = fakeRes();
    await AlertRulesController.create(post(rule), created as any);
    const res = fakeRes();
    await AlertRulesController.delete({ params: { id: created.body.data[0].id }, query: {} } as any, res as any);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(alertRuleStore.list()).toEqual([]);
  });
});

describe("alert rules routes", () => {
  it("declares GET/POST /alert-rules and PUT/DELETE /alert-rules/:id", () => {
    const layers = (alertRulesRoutes as any).stack as Array<{
      route?: { path: string; methods: Record<string, boolean> };
    }>;
    const declared = layers
      .filter((l) => l.route)
      .map((l) => `${Object.keys(l.route!.methods)[0].toUpperCase()} ${l.route!.path}`);
    expect(declared.sort()).toEqual(
      ["DELETE /alert-rules/:id", "GET /alert-rules", "POST /alert-rules", "PUT /alert-rules/:id"].sort()
    );
  });
});
