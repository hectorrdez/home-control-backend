import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { haGet, haPostText, warnIfHaMisconfigured } from "@modules/ha/HaClient";
import {
  HaNotConfiguredError,
  HaUnauthorizedError,
  HaUnexpectedResponseError,
  HaUnreachableError,
} from "@modules/ha/HaErrors";
import { silenceConsole } from "./helpers";

const fetchMock = vi.fn();

function reply(status: number, body: unknown, { text = false } = {}): Response {
  const payload = text ? String(body) : JSON.stringify(body);
  return new Response(payload, { status });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "test-ha-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("haGet", () => {
  it("joins HA_URL and path, stripping trailing slashes from the base", async () => {
    process.env.HA_URL = "http://ha.test:8123///";
    fetchMock.mockResolvedValue(reply(200, [{ ok: true }]));
    await expect(haGet("/api/states")).resolves.toEqual([{ ok: true }]);
    expect(fetchMock.mock.calls[0][0]).toBe("http://ha.test:8123/api/states");
  });

  it("sends the bearer token and JSON accept header", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await haGet("/api/");
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers).toEqual({ Authorization: "Bearer test-ha-token", Accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps 401 and 403 to HaUnauthorizedError (502)", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValueOnce(reply(status, {}));
      const err = await haGet("/api/").catch((e) => e);
      expect(err).toBeInstanceOf(HaUnauthorizedError);
      expect(err.getCode()).toBe(502);
      expect(err.getErrorCode()).toBe("ha_unauthorized");
    }
  });

  it("maps other non-2xx to HaUnexpectedResponseError with the status code", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, {}));
    const err = await haGet("/api/").catch((e) => e);
    expect(err).toBeInstanceOf(HaUnexpectedResponseError);
    expect(err.getMessage()).toBe("Home Assistant responded 500");
  });

  it("maps a network failure to HaUnreachableError (503)", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const err = await haGet("/api/").catch((e) => e);
    expect(err).toBeInstanceOf(HaUnreachableError);
    expect(err.getCode()).toBe(503);
  });

  it("maps a non-JSON body to HaUnexpectedResponseError", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    const err = await haGet("/api/").catch((e) => e);
    expect(err).toBeInstanceOf(HaUnexpectedResponseError);
    expect(err.getMessage()).toBe("Home Assistant returned a non-JSON body");
  });

  it("refuses to call HA when URL or token is missing", async () => {
    process.env.HA_TOKEN = "";
    await expect(haGet("/api/")).rejects.toBeInstanceOf(HaNotConfiguredError);
    process.env.HA_TOKEN = "t";
    process.env.HA_URL = "";
    await expect(haGet("/api/")).rejects.toBeInstanceOf(HaNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("haPostText", () => {
  it("POSTs the JSON body and returns the raw text", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, "a|b|c", { text: true }));
    await expect(haPostText("/api/template", { template: "x" })).resolves.toBe("a|b|c");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ha.test:8123/api/template");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer test-ha-token", "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ template: "x" });
  });

  it("applies the same error mapping as haGet", async () => {
    fetchMock.mockResolvedValueOnce(reply(401, {}));
    await expect(haPostText("/api/template", {})).rejects.toBeInstanceOf(HaUnauthorizedError);
    fetchMock.mockResolvedValueOnce(reply(404, {}));
    await expect(haPostText("/api/template", {})).rejects.toBeInstanceOf(HaUnexpectedResponseError);
    fetchMock.mockRejectedValueOnce(new Error("down"));
    await expect(haPostText("/api/template", {})).rejects.toBeInstanceOf(HaUnreachableError);
  });

  it("refuses when not configured", async () => {
    delete process.env.HA_URL;
    await expect(haPostText("/api/template", {})).rejects.toBeInstanceOf(HaNotConfiguredError);
  });
});

describe("warnIfHaMisconfigured", () => {
  it("logs a WARN line when HA_URL or HA_TOKEN is missing, never throws", () => {
    const con = silenceConsole();
    delete process.env.HA_TOKEN;
    expect(() => warnIfHaMisconfigured()).not.toThrow();
    expect(con.log.mock.calls[0][0]).toContain("HaClient");
    expect(con.log.mock.calls[0][0]).toContain("WARN");
  });

  it("is silent when both are set", () => {
    const con = silenceConsole();
    warnIfHaMisconfigured();
    expect(con.log).not.toHaveBeenCalled();
  });
});
