import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertRuleStore } from "@modules/alert-rules/AlertRuleStore";
import { AlertRulesWriteFailedError } from "@modules/alert-rules/AlertRuleErrors";
import { silenceConsole } from "./helpers";

let dir: string;
let file: string;

const rule = (entityId: string, over: Record<string, unknown> = {}) => ({
  entityId,
  trigger: { type: "connects" },
  level: "low",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-store-"));
  file = path.join(dir, "nested", "alert-rules.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const readJson = () => JSON.parse(fs.readFileSync(file, "utf8"));

describe("AlertRuleStore load", () => {
  it("starts empty when the file does not exist yet", () => {
    const store = new AlertRuleStore();
    store.load(file);
    expect(store.list()).toEqual([]);
    expect(store.get(randomUUID())).toBeUndefined();
  });

  it("loads valid rules and lists them sorted by entity id, then id", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const a = randomUUID();
    const b = randomUUID();
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, rules: { [b]: rule("light.b"), [a]: rule("light.a", { level: "high" }) } })
    );
    const store = new AlertRuleStore();
    store.load(file);
    expect(store.list().map((r) => r.entityId)).toEqual(["light.a", "light.b"]);
    expect(store.get(a)?.level).toBe("high");
  });

  it("skips invalid entries on load and logs how many were ignored", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const con = silenceConsole();
    const ok = randomUUID();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        rules: {
          [ok]: rule("light.ok"),
          "not-a-uuid": rule("light.bad_key"),
          [randomUUID()]: rule("BAD"),
          [randomUUID()]: "nope",
        },
      })
    );
    const store = new AlertRuleStore();
    store.load(file);
    expect(store.list().map((r) => r.id)).toEqual([ok]);
    const logged = con.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("ignored 3 invalid alert rule entries");
  });

  it("moves an unreadable file aside and starts empty", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    silenceConsole();
    fs.writeFileSync(file, "{not json");
    const store = new AlertRuleStore();
    store.load(file);
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith("alert-rules.json.corrupt-"))).toBe(true);
  });
});

describe("AlertRuleStore mutate", () => {
  it("persists a versioned file under the rules property and removes the tmp file", async () => {
    const store = new AlertRuleStore();
    store.load(file);
    const id = randomUUID();
    await store.mutate((d) => {
      d.set(id, rule("light.a", { message: "Hi" }) as never);
      return true;
    });
    const body = readJson();
    expect(body.version).toBe(1);
    expect(body.rules[id]).toMatchObject({ entityId: "light.a", message: "Hi" });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(store.list()).toHaveLength(1);
  });

  it("does not write when the change reports no modification", async () => {
    const store = new AlertRuleStore();
    store.load(file);
    await store.mutate(() => false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("keeps memory unchanged and throws the typed error when the write fails", async () => {
    const store = new AlertRuleStore();
    store.load(file);
    silenceConsole();
    vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(new Error("disk full"));
    const err = await store
      .mutate((d) => {
        d.set(randomUUID(), rule("light.a") as never);
        return true;
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AlertRulesWriteFailedError);
    expect(err.getErrorCode()).toBe("alert_rules_write_failed");
    expect(store.list()).toEqual([]);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
