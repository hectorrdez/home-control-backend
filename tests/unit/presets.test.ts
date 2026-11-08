import { randomUUID } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import calibrationStore from "@modules/calibrations/CalibrationStore";
import coverMoves from "@modules/covers/CoverMoves";
import { DomainNotAllowedError, EntityNotFoundError, InvalidEntityIdError } from "@modules/entities/EntityErrors";
import { HaState } from "@modules/ha/HaStates";
import { haGetOptional, haPostJson, haPostText } from "@modules/ha/HaClient";
import presetStoreDefault, { PresetStore } from "@modules/presets/PresetStore";
import { applyPreset, createPreset, deletePreset, listPresets, replacePreset, requirePreset } from "@modules/presets/PresetService";
import { cleanName, parseCreateBody, readPresetFields } from "@modules/presets/PresetValidation";
import { PresetNotFoundError } from "@modules/presets/PresetErrors";
import { InvalidPresetError } from "@modules/presets/PresetErrors";
import { appEvents, AppEvent } from "@shared/events/AppEvents";

import { silenceConsole } from "./helpers";

const ENTITY = "cover.persiana_salon_cortina";
const COVER_STATE: HaState = {
  entity_id: ENTITY,
  state: "closed",
  attributes: { friendly_name: "Persiana" },
  last_changed: "2026-01-01T00:00:00Z",
};

let seen: AppEvent[];
let off: () => void;

const docs = await vi.hoisted(async () => (await import("./fake-documents-db")).createFakeDocumentDb());
vi.mock("pg", () => ({ Pool: class { constructor() { return Object.assign(docs, { on: () => undefined }); } } }));

vi.mock("@modules/ha/HaClient", () => ({
  haGet: vi.fn(),
  haGetOptional: vi.fn(),
  haPostJson: vi.fn(),
  haPostText: vi.fn(),
  warnIfHaMisconfigured: vi.fn(),
}));

/** Resolves to the api error code of a rejected promise, or "no-error". */
async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { getErrorCode: () => string }).getErrorCode();
  }
  return "no-error";
}

beforeEach(async () => {
  silenceConsole();
  docs.reset();
  seen = [];
  off = appEvents.subscribe((evt) => seen.push(evt));
  vi.mocked(haGetOptional).mockReset().mockResolvedValue(COVER_STATE);
  vi.mocked(haPostJson).mockReset().mockResolvedValue([]);
  vi.mocked(haPostText).mockReset().mockResolvedValue("");
  // The module service uses the default store on the (faked) pool: load it empty.
  await presetStoreDefault.load();
});

afterEach(async () => {
  off();
  vi.restoreAllMocks();
  await calibrationStore.mutate((d) => d.delete(ENTITY));
});

describe("preset validation", () => {
  it("accepts a cover id and trims the name", () => {
    expect(parseCreateBody({ entityId: ENTITY, name: "  Media ", percent: 50 })).toEqual({
      entityId: ENTITY,
      name: "Media",
      percent: 50,
    });
  });

  it("rejects a malformed entity id (400) and a non-cover domain (403)", () => {
    expect(() => parseCreateBody({ entityId: "Cover.X", name: "a", percent: 1 })).toThrow(InvalidEntityIdError);
    expect(() => parseCreateBody({ entityId: "cover", name: "a", percent: 1 })).toThrow(InvalidEntityIdError);
    expect(() => parseCreateBody({ entityId: "light.x", name: "a", percent: 1 })).toThrow(DomainNotAllowedError);
  });

  it("rejects names that are empty, too long or hold control characters", () => {
    expect(cleanName("   ")).toBeUndefined();
    expect(cleanName("a".repeat(31))).toBeUndefined();
    expect(cleanName("a".repeat(30))).toBe("a".repeat(30));
    expect(cleanName("bad\u0007name")).toBeUndefined();
    expect(cleanName(12)).toBeUndefined();
    expect(() => parseCreateBody({ entityId: ENTITY, name: "", percent: 1 })).toThrow(InvalidPresetError);
  });

  it("rejects percent outside integer 0..100", () => {
    for (const percent of [-1, 101, 1.5, "50", null]) {
      expect(() => parseCreateBody({ entityId: ENTITY, name: "x", percent })).toThrow(InvalidPresetError);
    }
    expect(() => parseCreateBody({ entityId: ENTITY, name: "x", percent: 0 })).not.toThrow();
    expect(() => parseCreateBody({ entityId: ENTITY, name: "x", percent: 100 })).not.toThrow();
  });

  it("drops invalid stored values on load", () => {
    expect(readPresetFields({ entityId: ENTITY, name: "ok", percent: 3, createdAt: "t" })).toBeDefined();
    expect(readPresetFields({ entityId: "light.x", name: "ok", percent: 3, createdAt: "t" })).toBeUndefined();
    expect(readPresetFields({ entityId: ENTITY, name: "ok", percent: 3 })).toBeUndefined();
  });
});

describe("preset store and service", () => {
  it("lists by entity, sorted by entity, then percent, then name", async () => {
    await createPreset({ entityId: ENTITY, name: "Lectura", percent: 30 });
    await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    await createPreset({ entityId: "cover.other", name: "Zeta", percent: 0 });
    // cover.other sorts before cover.persiana_salon_cortina; inside an entity: percent asc.
    expect(listPresets().map((p) => p.name)).toEqual(["Zeta", "Lectura", "Media"]);
    expect(listPresets(ENTITY).map((p) => p.percent)).toEqual([30, 50]);
  });

  it("rejects a duplicate name case-insensitively within one entity, but allows it on another", async () => {
    await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    expect(await errorCode(createPreset({ entityId: ENTITY, name: " MEDIA ", percent: 10 }))).toBe("duplicate_preset");
    await expect(createPreset({ entityId: "cover.other", name: "media", percent: 10 })).resolves.toHaveLength(1);
  });

  it("caps at 10 presets per entity", async () => {
    for (let i = 0; i < 10; i++) await createPreset({ entityId: ENTITY, name: `p${i}`, percent: i });
    expect(await errorCode(createPreset({ entityId: ENTITY, name: "p10", percent: 1 }))).toBe("too_many_presets");
    await expect(createPreset({ entityId: "cover.other", name: "p0", percent: 1 })).resolves.toHaveLength(1);
  });

  it("PUT renames and keeps the id; refuses a changed entityId and an unknown id", async () => {
    const [created] = await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    const [updated] = await replacePreset(created.id, { name: "Medio", percent: 40 });
    expect(updated).toMatchObject({ id: created.id, entityId: ENTITY, name: "Medio", percent: 40 });
    expect(await errorCode(replacePreset(created.id, { name: "x", percent: 1, entityId: "cover.other" }))).toBe("invalid_preset");
    expect(await errorCode(replacePreset(randomUUID(), { name: "x", percent: 1 }))).toBe("preset_not_found");
  });

  it("DELETE is idempotent and returns an empty array", async () => {
    const [created] = await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    expect(await deletePreset(created.id)).toEqual([]);
    expect(await deletePreset(created.id)).toEqual([]);
    expect(listPresets(ENTITY)).toEqual([]);
  });

  it("emits resource_changed presets once per successful mutate, with by", async () => {
    await createPreset({ entityId: ENTITY, name: "Media", percent: 50 }, "client-7");
    const events = seen.filter((e) => e.type === "resource_changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ resource: "presets", by: "client-7" });
  });

  it("a rejected create emits nothing and leaves memory unchanged", async () => {
    await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    const before = listPresets().length;
    expect(await errorCode(createPreset({ entityId: ENTITY, name: "media", percent: 1 }))).toBe("duplicate_preset");
    expect(listPresets().length).toBe(before);
    expect(seen.filter((e) => e.type === "resource_changed")).toHaveLength(1);
  });

  it("the store class loads and lists from its own collection", async () => {
    const store = new PresetStore(docs);
    await store.load();
    expect(store.list()).toEqual([]);
  });
});

describe("preset apply", () => {
  it("drives a calibrated cover through the 011 timed move", async () => {
    await calibrationStore.mutate((d) => {
      d.set(ENTITY, { openMs: 10000, closeMs: 20000, position: 100, calibratedAt: "2026-01-01T00:00:00.000Z" });
      return true;
    });
    const move = vi.spyOn(coverMoves, "moveTo").mockResolvedValue(undefined);
    const [created] = await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    await applyPreset(requirePreset(created.id));
    expect(move).toHaveBeenCalledWith(ENTITY, 50);
  });

  it("sends set_cover_position for a cover with a numeric current_position", async () => {
    vi.mocked(haGetOptional).mockResolvedValue({ ...COVER_STATE, attributes: { current_position: 20 } });
    const [created] = await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    await applyPreset(requirePreset(created.id));
    expect(haPostJson).toHaveBeenCalledWith("/api/services/cover/set_cover_position", { entity_id: ENTITY, position: 50 });
  });

  it("409 preset_not_applicable when the cover has neither calibration nor position", async () => {
    const [created] = await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    expect(await errorCode(applyPreset(requirePreset(created.id)))).toBe("preset_not_applicable");
    expect(haPostJson).not.toHaveBeenCalled();
  });

  it("404 entity_not_found when HA does not know the entity", async () => {
    vi.mocked(haGetOptional).mockResolvedValue(null);
    const [created] = await createPreset({ entityId: ENTITY, name: "Media", percent: 50 });
    await expect(applyPreset(requirePreset(created.id))).rejects.toThrow(EntityNotFoundError);
  });

  it("404 preset_not_found for an unknown id, with no HA call", () => {
    expect(() => requirePreset(randomUUID())).toThrow(PresetNotFoundError);
    expect(haGetOptional).not.toHaveBeenCalled();
  });
});
