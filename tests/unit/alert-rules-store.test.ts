import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AlertRuleStore } from "@modules/alert-rules/AlertRuleStore";
import { createFakeDocumentDb, FakeDocumentDb } from "./fake-documents-db";
import { silenceConsole } from "./helpers";

let db: FakeDocumentDb;

const rule = (entityId: string, over: Record<string, unknown> = {}) => ({
  entityId,
  trigger: { type: "connects" },
  level: "low",
  ...over,
});

beforeEach(() => {
  db = createFakeDocumentDb();
});

describe("AlertRuleStore load", () => {
  it("lists valid rules sorted by entity id, then id", async () => {
    const a = randomUUID();
    const b = randomUUID();
    db.seed("alert_rules", { [b]: rule("light.b"), [a]: rule("light.a", { level: "high" }) });
    const store = new AlertRuleStore(db);
    await store.load();
    expect(store.list().map((r) => r.entityId)).toEqual(["light.a", "light.b"]);
    expect(store.get(a)?.level).toBe("high");
  });

  it("skips invalid rows and logs how many were ignored", async () => {
    const con = silenceConsole();
    const ok = randomUUID();
    db.seed("alert_rules", {
      [ok]: rule("light.ok"),
      "not-a-uuid": rule("light.bad_key"),
      [randomUUID()]: rule("BAD"),
      [randomUUID()]: "nope",
    });
    const store = new AlertRuleStore(db);
    await store.load();
    expect(store.list().map((r) => r.id)).toEqual([ok]);
    expect(con.log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("ignored 3 invalid alert rule entries");
  });
});
