import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Logger from "@utils/Logger";
import DateUtils from "@utils/Date";
import { silenceConsole } from "./helpers";

const listen = vi.fn((_port: number, cb?: () => void) => cb?.());
const load = vi.fn();

// Stub the app and the alias store so importing the bootstrap never opens a port or touches /data.
vi.mock("../../src/app", () => ({ default: { listen } }));
vi.mock("@modules/aliases/AliasStore", () => ({ default: { load } }));

async function boot(port: string | undefined) {
  if (port === undefined) delete process.env.API_PORT;
  else process.env.API_PORT = port;
  vi.resetModules();
  return import("../../src/index");
}

beforeEach(() => {
  listen.mockClear();
  load.mockClear();
  delete process.env.ALIASES_FILE;
});

afterEach(() => {
  delete process.env.API_PORT;
});

describe("bootstrap (src/index.ts)", () => {
  it("listens on API_PORT and loads the aliases file", async () => {
    silenceConsole();
    process.env.ALIASES_FILE = "/tmp/custom-aliases.json";
    await boot("4123");
    expect(listen).toHaveBeenCalledWith(4123, expect.any(Function));
    expect(load).toHaveBeenCalledWith("/tmp/custom-aliases.json");
  });

  it("defaults to port 3002 and the /data aliases file", async () => {
    silenceConsole();
    await boot(undefined);
    expect(listen.mock.calls[0][0]).toBe(3002);
    expect(load).toHaveBeenCalledWith("/data/aliases.json");
  });

  it.each(["0", "65536", "abc", "1.5"])("refuses to start with API_PORT=%s", async (port) => {
    silenceConsole();
    await expect(boot(port)).rejects.toThrow("API_PORT must be an integer between 1 and 65535");
    expect(listen).not.toHaveBeenCalled();
  });
});

describe("Logger", () => {
  it("writes scope, type and text to the console", () => {
    const con = silenceConsole();
    Logger.write("hello", "Scope", "WARN");
    expect(con.log.mock.calls[0][0]).toMatch(/^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\]\[Scope\]WARN: hello$/);
  });

  it("defaults to scope API and type INFO", () => {
    const con = silenceConsole();
    Logger.write("plain");
    expect(con.log.mock.calls[0][0]).toContain("[API]INFO: plain");
  });

  it("error() logs at ERROR level", () => {
    const con = silenceConsole();
    Logger.error("boom", "Core");
    expect(con.log.mock.calls[0][0]).toContain("[Core]ERROR: boom");
  });

  it("init() does nothing unless LOG_TO_FILE=true", () => {
    process.env.LOG_TO_FILE = "false";
    expect(() => Logger.init()).not.toThrow();
  });
});

describe("DateUtils", () => {
  it("formats local time as YYYY/MM/DD HH:mm:ss", () => {
    expect(DateUtils.obtainCurrentDateString()).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("formats a Date for MySQL-style storage in UTC", () => {
    expect(DateUtils.toMySQLFormat(new Date("2026-02-03T04:05:06.789Z"))).toBe("2026-02-03 04:05:06");
  });
});
