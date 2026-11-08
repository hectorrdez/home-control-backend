import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import settingStore from "@modules/settings/SettingStore";
import { deleteSetting, getSetting, listSettings, putSetting } from "@modules/settings/SettingsService";
import {
  InvalidSettingError,
  InvalidSettingKeyError,
  SettingNotFoundError,
  SettingTooLargeError,
  SettingsWriteFailedError,
  TooManySettingsError,
  VersionConflictError,
} from "@modules/settings/SettingErrors";
import { isValidSettingKey, parseSettingBody } from "@modules/settings/SettingValidation";
import { appEvents, AppEvent } from "@shared/events/AppEvents";
import { silenceConsole } from "./helpers";
const docs = await vi.hoisted(async () => (await import("./fake-documents-db")).createFakeDocumentDb());
vi.mock("pg", () => ({ Pool: class { constructor() { return Object.assign(docs, { on: () => undefined }); } } }));

let seen: AppEvent[];
let off: () => void;

beforeEach(async () => {
  docs.reset();
  silenceConsole();
  seen = [];
  off = appEvents.subscribe((evt) => seen.push(evt));
  await settingStore.load();
});

afterEach(() => off());

describe("setting key and body validation", () => {
  it("accepts 2..5 dot-separated segments and rejects anything else", () => {
    expect(isValidSettingKey("telemetry.widgets")).toBe(true);
    expect(isValidSettingKey("telemetry.panels.left-1.v_2")).toBe(true);
    expect(isValidSettingKey("single")).toBe(false);
    expect(isValidSettingKey("Bad.Key")).toBe(false);
    expect(isValidSettingKey("Bad Key")).toBe(false);
    expect(isValidSettingKey("a.b.c.d.e.f")).toBe(false);
  });

  it("rejects keys longer than 80 characters", () => {
    const long = `a.${"b".repeat(78)}`;
    expect(long.length).toBe(80);
    expect(isValidSettingKey(long)).toBe(true);
    expect(isValidSettingKey(`${long}b`)).toBe(false);
  });

  it("accepts a serialized value of exactly 65536 bytes and rejects 65537 with 413", () => {
    const exact = { s: "x".repeat(65536 - '{"s":""}'.length) };
    expect(JSON.stringify(exact).length).toBe(65536);
    expect(() => parseSettingBody({ value: exact })).not.toThrow();
    const over = { s: "x".repeat(65537 - '{"s":""}'.length) };
    expect(() => parseSettingBody({ value: over })).toThrow(SettingTooLargeError);
  });

  it("requires a value property and an integer baseVersion >= 1 when given", () => {
    expect(() => parseSettingBody({})).toThrow(InvalidSettingError);
    expect(() => parseSettingBody(null)).toThrow(InvalidSettingError);
    expect(() => parseSettingBody({ value: 1, baseVersion: 0 })).toThrow(InvalidSettingError);
    expect(() => parseSettingBody({ value: 1, baseVersion: 1.5 })).toThrow(InvalidSettingError);
    expect(() => parseSettingBody({ value: null })).not.toThrow();
  });
});

describe("settings service", () => {
  it("creates a key at version 1 with updatedBy from the client id", async () => {
    await expect(putSetting("telemetry.widgets", { value: [1] }, "client-a")).resolves.toMatchObject([
      { key: "telemetry.widgets", value: [1], version: 1, updatedBy: "client-a" },
    ]);
    expect(getSetting("telemetry.widgets")[0].version).toBe(1);
    expect(docs.snapshot("settings")["telemetry.widgets"]).toMatchObject({ version: 1, updatedBy: "client-a" });
  });

  it("updates an existing key to version 2 and stamps the new writer", async () => {
    await putSetting("telemetry.widgets", { value: [1] }, "client-a");
    const out = await putSetting("telemetry.widgets", { value: [2] }, "client-b");
    expect(out[0]).toMatchObject({ version: 2, value: [2], updatedBy: "client-b" });
  });

  it("keeps the value's updatedAt equal to the row's updated_at after create and after update", async () => {
    const rowKey = "settings\u0000telemetry.widgets";
    await putSetting("telemetry.widgets", { value: [1] }, "client-a");
    const created = docs.rows.get(rowKey);
    expect(created?.updated_at).toBe(getSetting("telemetry.widgets")[0].updatedAt);

    await putSetting("telemetry.widgets", { value: [2] }, "client-b");
    const updated = getSetting("telemetry.widgets")[0];
    expect(docs.rows.get(rowKey)?.updated_at).toBe(updated.updatedAt);
    expect(Date.parse(updated.updatedAt)).toBe(Date.parse(docs.rows.get(rowKey)!.updated_at!));
  });

  it("does not write or bump the version when the value is the same", async () => {
    await putSetting("telemetry.widgets", { value: { a: 1 } });
    docs.statements.length = 0;
    seen.length = 0;
    const out = await putSetting("telemetry.widgets", { value: { a: 1 } }, "client-b");
    expect(out[0].version).toBe(1);
    expect(docs.statements).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("accepts a matching baseVersion and rejects a mismatch with the current setting", async () => {
    await putSetting("telemetry.panels", { value: "a" });
    await putSetting("telemetry.panels", { value: "b", baseVersion: 1 });
    expect(getSetting("telemetry.panels")[0].version).toBe(2);

    const err = await putSetting("telemetry.panels", { value: "c", baseVersion: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err.getCode()).toBe(409);
    expect(err.getErrorCode()).toBe("version_conflict");
    expect(err.current).toMatchObject({ version: 2, value: "b" });
    expect(getSetting("telemetry.panels")[0].value).toBe("b");
  });

  it("returns a conflict without current when baseVersion is given for a missing key", async () => {
    const err = await putSetting("telemetry.filters", { value: 1, baseVersion: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err.current).toBeUndefined();
  });

  it("enforces the 200 key cap but still allows replacing an existing key", async () => {
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) seeded[`app.k${i}`] = { value: i, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: null };
    docs.seed("settings", seeded);
    await settingStore.load();
    expect(listSettings()).toHaveLength(200);

    await expect(putSetting("app.new", { value: 1 })).rejects.toBeInstanceOf(TooManySettingsError);
    await expect(putSetting("app.k0", { value: "changed" })).resolves.toMatchObject([{ key: "app.k0", version: 2 }]);
  });

  it("delete is idempotent and emits only when a key was removed", async () => {
    await putSetting("telemetry.widgets", { value: 1 });
    seen.length = 0;
    await expect(deleteSetting("telemetry.widgets", "client-c")).resolves.toEqual([]);
    expect(listSettings()).toEqual([]);
    expect(seen).toEqual([{ type: "resource_changed", resource: "settings", keys: ["telemetry.widgets"], by: "client-c" }]);

    seen.length = 0;
    await expect(deleteSetting("telemetry.widgets")).resolves.toEqual([]);
    expect(seen).toEqual([]);
  });

  it("emits resource_changed for settings only on a real write", async () => {
    await putSetting("telemetry.widgets", { value: 1 }, "client-a");
    expect(seen).toEqual([{ type: "resource_changed", resource: "settings", keys: ["telemetry.widgets"], by: "client-a" }]);
  });

  it("keeps memory unchanged and emits nothing when the database write fails", async () => {
    await putSetting("telemetry.widgets", { value: 1 }, "client-a");
    seen.length = 0;
    docs.failNext(/INSERT INTO documents/);
    await expect(putSetting("telemetry.widgets", { value: 2 }, "client-b")).rejects.toBeInstanceOf(SettingsWriteFailedError);
    expect(getSetting("telemetry.widgets")[0]).toMatchObject({ value: 1, version: 1, updatedBy: "client-a" });
    expect(docs.snapshot("settings")["telemetry.widgets"]).toMatchObject({ value: 1, version: 1 });
    expect(seen).toEqual([]);
  });

  it("rejects an oversized replacement without changing the stored setting", async () => {
    await putSetting("telemetry.widgets", { value: 1 });
    seen.length = 0;
    await expect(putSetting("telemetry.widgets", { value: "x".repeat(65535) })).rejects.toBeInstanceOf(SettingTooLargeError);
    expect(getSetting("telemetry.widgets")[0]).toMatchObject({ value: 1, version: 1 });
    expect(seen).toEqual([]);
  });

  it("returns setting_not_found for an unknown key and invalid_setting_key for a bad key", async () => {
    expect(() => getSetting("telemetry.missing")).toThrow(SettingNotFoundError);
    expect(() => getSetting("Bad Key")).toThrow(InvalidSettingKeyError);
    await expect(deleteSetting("Bad Key")).rejects.toBeInstanceOf(InvalidSettingKeyError);
  });
});

describe("settings store load", () => {
  it("skips invalid rows and logs the count", async () => {
    const con = silenceConsole();
    docs.seed("settings", {
      "app.ok": { value: 1, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: null },
      "BAD.key": { value: 1, version: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: null },
      "app.noversion": { value: 1, updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: null },
    });
    await settingStore.load();
    expect(listSettings().map((s) => s.key)).toEqual(["app.ok"]);
    expect(con.log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("ignored 2 invalid setting entries");
  });
});
