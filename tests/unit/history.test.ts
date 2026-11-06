import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHistory, parseEntityIds, parseHours } from "@modules/history/HistoryService";
import { InvalidHoursError, MissingEntityIdsError, TooManyEntitiesError } from "@modules/history/HistoryErrors";
import { InvalidEntityIdError } from "@modules/entities/EntityErrors";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.HA_URL = "http://ha.test:8123";
  process.env.HA_TOKEN = "t";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseEntityIds", () => {
  it("splits, trims and deduplicates", () => {
    expect(parseEntityIds(" light.a , switch.b,light.a ,, ")).toEqual(["light.a", "switch.b"]);
  });

  it("requires at least one id", () => {
    expect(() => parseEntityIds(undefined)).toThrow(MissingEntityIdsError);
    expect(() => parseEntityIds(" , ,")).toThrow(MissingEntityIdsError);
  });

  it("accepts exactly 20 and rejects 21", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `light.e${i}`).join(",");
    expect(parseEntityIds(twenty)).toHaveLength(20);
    const twentyOne = `${twenty},light.extra`;
    expect(() => parseEntityIds(twentyOne)).toThrow(TooManyEntitiesError);
  });

  it("does not count duplicates towards the limit", () => {
    const dupes = Array.from({ length: 30 }, () => "light.same").join(",");
    expect(parseEntityIds(dupes)).toEqual(["light.same"]);
  });

  it("rejects ids that fail the entity regex", () => {
    for (const bad of ["Light.a", "light", "light.a.b", "light.a-b", "../etc", "light.A"]) {
      expect(() => parseEntityIds(bad)).toThrow(InvalidEntityIdError);
    }
  });
});

describe("parseHours", () => {
  it("defaults to 24 when absent", () => {
    expect(parseHours(undefined)).toBe(24);
  });

  it("accepts integers 1..720 inclusive", () => {
    expect(parseHours("1")).toBe(1);
    expect(parseHours("720")).toBe(720);
    expect(parseHours("012")).toBe(12);
  });

  it("rejects 0, above 720, decimals, signs, and non-numeric input", () => {
    for (const bad of ["0", "721", "1.5", "-3", "+2", "abc", "", " 5"]) {
      expect(() => parseHours(bad)).toThrow(InvalidHoursError);
    }
  });
});

describe("fetchHistory", () => {
  const now = new Date("2026-03-01T12:00:00.000Z");

  it("queries the recorder for the window ending now, with minimal + significant-only filters", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
    await fetchHistory(["light.a", "switch.b"], 2, now);

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/history/period/2026-03-01T10:00:00.000Z");
    expect(url.searchParams.get("filter_entity_id")).toBe("light.a,switch.b");
    expect(url.searchParams.get("end_time")).toBe("2026-03-01T12:00:00.000Z");
    expect(url.searchParams.has("minimal_response")).toBe(true);
    expect(url.searchParams.has("significant_changes_only")).toBe(true);
  });

  it("maps each run to its entity, preferring last_changed and falling back to last_updated", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          [
            { entity_id: "light.a", state: "on", last_changed: "2026-03-01T11:00:00+01:00" },
            { state: "off", last_changed: "2026-03-01T11:30:00.000Z" },
          ],
          [{ entity_id: "switch.b", state: 0, last_updated: "2026-03-01T09:00:00.000Z" }],
        ]),
        { status: 200 }
      )
    );
    const out = await fetchHistory(["light.a", "switch.b"], 24, now);
    expect(out).toEqual([
      {
        entityId: "light.a",
        points: [
          { t: "2026-03-01T10:00:00.000Z", v: "on" },
          { t: "2026-03-01T11:30:00.000Z", v: "off" },
        ],
      },
      { entityId: "switch.b", points: [{ t: "2026-03-01T09:00:00.000Z", v: "0" }] },
    ]);
  });

  it("keeps unparseable timestamps as the raw string", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([[{ entity_id: "light.a", state: "on", last_changed: "yesterday" }]]), { status: 200 })
    );
    const [h] = await fetchHistory(["light.a"], 1, now);
    expect(h.points[0].t).toBe("yesterday");
  });

  it("returns empty points for requested entities without recorded history, in request order", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([[{ entity_id: "switch.b", state: "on", last_changed: "2026-03-01T11:00:00Z" }]]), {
        status: 200,
      })
    );
    const out = await fetchHistory(["light.missing", "switch.b"], 1, now);
    expect(out.map((h) => h.entityId)).toEqual(["light.missing", "switch.b"]);
    expect(out[0].points).toEqual([]);
    expect(out[1].points).toHaveLength(1);
  });

  it("treats a non-array HA reply as no history", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: "nope" }), { status: 200 }));
    await expect(fetchHistory(["light.a"], 1, now)).resolves.toEqual([{ entityId: "light.a", points: [] }]);
  });

  it("skips runs that carry no entity_id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([[{ state: "on" }]]), { status: 200 }));
    await expect(fetchHistory(["light.a"], 1, now)).resolves.toEqual([{ entityId: "light.a", points: [] }]);
  });
});
