import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HaState } from "@modules/ha/HaStates";
import { silenceConsole } from "./helpers";

const fetchMock = vi.fn();

function state(entity_id: string, friendly = ""): HaState {
  return {
    entity_id,
    state: "on",
    last_changed: "2026-01-01T10:00:00+00:00",
    attributes: friendly ? { friendly_name: friendly } : {},
  } as HaState;
}

/** HaStates keeps module-level caches, so every test loads a fresh module. */
async function loadStates() {
  vi.resetModules();
  return import("@modules/ha/HaStates");
}

const templateReply = (text: string) => new Response(text, { status: 200 });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "t";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseDeviceNames", () => {
  it("splits on the first | only, so a device name may contain |", async () => {
    const { parseDeviceNames } = await loadStates();
    const out = parseDeviceNames("sensor.a|Cocina | Norte\n");
    expect(out.get("sensor.a")).toBe("Cocina | Norte");
  });

  it("ignores blank lines, lines without a pipe or without an entity id, and empty names", async () => {
    const { parseDeviceNames } = await loadStates();
    const out = parseDeviceNames("\nnot-an-entity|Foo\nlight.kitchen|\nlight.bed|  RT-AC65P  \r\nno pipe here\n");
    expect([...out.entries()]).toEqual([["light.bed", "RT-AC65P"]]);
  });
});

describe("fetchDeviceNameIndex", () => {
  it("makes ONE batched /api/template call and caches the result for 60s", async () => {
    const { fetchDeviceNameIndex } = await loadStates();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    fetchMock.mockResolvedValue(templateReply("light.a|RT-AC65P\nlight.b|\n"));

    const first = await fetchDeviceNameIndex();
    expect(first.get("light.a")).toBe("RT-AC65P");
    expect(first.has("light.b")).toBe(false);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://ha.test:8123/api/template");
    expect(JSON.parse(String(init.body)).template).toContain("device_attr(s.entity_id, 'name_by_user')");

    now.mockReturnValue(1_000_000 + 59_000);
    await fetchDeviceNameIndex();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 61_000);
    await fetchDeviceNameIndex();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const { fetchDeviceNameIndex } = await loadStates();
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));

    const a = fetchDeviceNameIndex();
    const b = fetchDeviceNameIndex();
    release(templateReply("light.a|Lamp\n"));
    const [ra, rb] = await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);
    expect(ra.get("light.a")).toBe("Lamp");
  });

  it("degrades to an empty map on HA failure, logs a warning, and retries after the short failure cache", async () => {
    const { fetchDeviceNameIndex } = await loadStates();
    const log = silenceConsole();
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const failed = await fetchDeviceNameIndex();
    expect(failed.size).toBe(0);
    expect(log.log.mock.calls.flat().join(" ")).toContain("deviceName=null");
    expect(log.log.mock.calls.flat().join(" ")).not.toContain("boom");

    now.mockReturnValue(2_000_000 + 5_000);
    await fetchDeviceNameIndex();
    expect(fetchMock).toHaveBeenCalledTimes(1); // failure cached for ~10s only

    now.mockReturnValue(2_000_000 + 11_000);
    fetchMock.mockResolvedValueOnce(templateReply("light.a|Lamp\n"));
    expect((await fetchDeviceNameIndex()).get("light.a")).toBe("Lamp");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("degrades on network errors and timeouts too (never rejects)", async () => {
    const { fetchDeviceNameIndex } = await loadStates();
    silenceConsole();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(fetchDeviceNameIndex()).resolves.toEqual(new Map());
  });

  it("degrades to an empty map when HA is not configured", async () => {
    const { fetchDeviceNameIndex } = await loadStates();
    silenceConsole();
    delete process.env.HA_URL;
    await expect(fetchDeviceNameIndex()).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("normalizeEntity deviceName", () => {
  it("carries the device name from the index, and null when absent or no index is passed", async () => {
    const { normalizeEntity } = await loadStates();
    const names = new Map([["light.bed", "RT-AC65P"]]);
    expect(normalizeEntity(state("light.bed"), new Map(), names).deviceName).toBe("RT-AC65P");
    expect(normalizeEntity(state("light.other"), new Map(), names).deviceName).toBeNull();
    expect(normalizeEntity(state("light.bed"), new Map()).deviceName).toBeNull();
  });
});
