import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventLog } from "@modules/events/EventLog";
import EntitiesController from "@modules/entities/EntitiesController";
import { controlEntity } from "@modules/entities/EntitiesControlService";
import { setCoverPercent } from "@modules/covers/CoverPercentService";
import { recordEntityAction } from "@modules/events/ActionRecorder";
import { InvalidEntityIdError, InvalidActionError, EntityNotFoundError } from "@modules/entities/EntityErrors";
import ApiError from "@errors/ApiError";
import { fakeRes, silenceConsole } from "./helpers";

vi.mock("@modules/entities/EntitiesControlService", () => ({ controlEntity: vi.fn() }));
vi.mock("@modules/covers/CoverPercentService", () => ({ setCoverPercent: vi.fn() }));

let record: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  silenceConsole();
  record = vi.spyOn(eventLog, "record").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const payloadOf = (call: number) => record.mock.calls[call][0].payload;

describe("recordEntityAction", () => {
  it("records ok:true after the action resolves and returns its result unchanged", async () => {
    const res: any = { locals: { clientId: "c-1", clientName: "Tablet" } };
    const result = { entityId: "light.a", state: "on" };
    const out = await recordEntityAction(
      res,
      { entityId: "light.a", action: "turn_on", params: { brightness: 200 } },
      async () => result
    );
    expect(out).toBe(result);
    expect(record).toHaveBeenCalledWith({
      type: "action",
      source: "api",
      entityId: "light.a",
      payload: { action: "turn_on", params: { brightness: 200 }, ok: true },
      clientId: "c-1",
      clientName: "Tablet",
    });
  });

  it("records ok:false with the ApiError code and rethrows the same error", async () => {
    const res: any = { locals: {} };
    const error = new EntityNotFoundError();
    await expect(
      recordEntityAction(res, { entityId: "light.a", action: "turn_on" }, async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(payloadOf(0)).toEqual({ action: "turn_on", ok: false, error: "entity_not_found" });
    expect(record.mock.calls[0][0]).toMatchObject({ clientId: null, clientName: null });
  });

  it("records internal_error for a non-ApiError failure", async () => {
    const res: any = { locals: {} };
    await expect(
      recordEntityAction(res, { entityId: "light.a", action: "turn_on" }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(payloadOf(0)).toMatchObject({ ok: false, error: "internal_error" });
  });

  it("does not record when the entity id is invalid", async () => {
    const res: any = { locals: {} };
    await expect(
      recordEntityAction(res, { entityId: "BAD", action: "turn_on" }, async () => {
        throw new InvalidEntityIdError();
      })
    ).rejects.toBeInstanceOf(InvalidEntityIdError);
    expect(record).not.toHaveBeenCalled();
  });

  it("records validation failures of a known entity, without params when none were sent", async () => {
    const res: any = { locals: {} };
    await expect(
      recordEntityAction(res, { entityId: "light.a", action: "explode" }, async () => {
        throw new InvalidActionError();
      })
    ).rejects.toBeInstanceOf(ApiError);
    expect(payloadOf(0)).toEqual({ action: "explode", ok: false, error: "invalid_action" });
  });
});

describe("EntitiesController action recording", () => {
  it("records a successful action and keeps the response body unchanged", async () => {
    vi.mocked(controlEntity).mockResolvedValue({ entityId: "light.a", state: "on" } as any);
    const res = fakeRes();
    res.locals.clientId = "c-9";
    await EntitiesController.action(
      { params: { entityId: "light.a" }, body: { action: "turn_on", params: { brightness: 10 } } } as any,
      res as any
    );
    expect(controlEntity).toHaveBeenCalledWith("light.a", { action: "turn_on", params: { brightness: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([{ entityId: "light.a", state: "on" }]);
    expect(record.mock.calls[0][0]).toMatchObject({ type: "action", entityId: "light.a", clientId: "c-9" });
    expect(payloadOf(0)).toEqual({ action: "turn_on", params: { brightness: 10 }, ok: true });
  });

  it("does not record the cover-percent request when the entity id is invalid", async () => {
    vi.mocked(setCoverPercent).mockImplementation(async (id: string) => {
      if (id === "BAD") throw new InvalidEntityIdError();
      return [];
    });
    const res = fakeRes();
    await EntitiesController.coverPercent({ params: { entityId: "BAD" }, body: { percent: 50 } } as any, res as any);
    expect(res.statusCode).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("records cover-percent as cover_percent with the percent param", async () => {
    vi.mocked(setCoverPercent).mockRejectedValue(new EntityNotFoundError());
    const res = fakeRes();
    await EntitiesController.coverPercent({ params: { entityId: "cover.a" }, body: { percent: 40 } } as any, res as any);
    expect(res.statusCode).toBe(404);
    expect(payloadOf(0)).toEqual({
      action: "cover_percent",
      params: { percent: 40 },
      ok: false,
      error: "entity_not_found",
    });
  });
});
