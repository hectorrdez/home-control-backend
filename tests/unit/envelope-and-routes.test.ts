import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApiError from "@errors/ApiError";
import RouteNotFoundError from "@errors/RouteNotFoundError";
import DataView from "@views/DataView";
import ErrorView from "@views/ErrorView";
import Controller from "@templates/Controller";
import RouteNotDeclaredError from "@errors/RouteNotDeclaredError";
import { route, sendOk, HANDLED } from "@shared/http/route";
import errorHandler from "@shared/middlewares/ErrorMiddleware";
import { parseAction, ALLOWED_DOMAINS, ALLOWED_ACTIONS } from "@modules/entities/EntitiesControlService";
import { InvalidActionError, InvalidParamsError } from "@modules/entities/EntityErrors";
import { silenceConsole, fakeRes, startApp } from "./helpers";

class WidgetNotFoundError extends ApiError {
  constructor() {
    super("no widget", 404);
  }
}

class PlainCodeError extends ApiError {
  constructor() {
    super("custom", 409, "already_there");
  }
}

beforeEach(() => {
  process.env.API_TOKEN = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApiError", () => {
  it("uses an explicit error code when given", () => {
    const e = new PlainCodeError();
    expect(e.getCode()).toBe(409);
    expect(e.getErrorCode()).toBe("already_there");
    expect(e.getMessage()).toBe("custom");
    expect(e.message).toBe("ERROR 409: custom");
  });

  it("derives a snake_case code from the class name when none is given", () => {
    expect(new WidgetNotFoundError().getErrorCode()).toBe("widget_not_found");
  });

  it("falls back to not_found / internal_error for a bare ApiError", () => {
    expect(new ApiError("x", 404).getErrorCode()).toBe("not_found");
    expect(new ApiError("x", 500).getErrorCode()).toBe("internal_error");
    expect(new ApiError().getCode()).toBe(500);
  });
});

describe("envelope views", () => {
  it("DataView wraps objects in an array and keeps arrays as-is", () => {
    const res = fakeRes();
    new DataView(res as any, { a: 1 }).send();
    expect(res.body).toEqual({
      code: 200,
      status: "resolved",
      entry: "2026/01/01 00:00:00",
      exit: expect.any(String),
      data: [{ a: 1 }],
      error: "",
    });

    const res2 = fakeRes();
    new DataView(res2 as any, [1, 2], 201).send();
    expect(res2.statusCode).toBe(201);
    expect((res2.body as any).data).toEqual([1, 2]);
  });

  it("DataView turns null and undefined into an empty array", () => {
    const res = fakeRes();
    new DataView(res as any, null).send();
    expect((res.body as any).data).toEqual([]);
    const res2 = fakeRes();
    new DataView(res2 as any, undefined).send();
    expect((res2.body as any).data).toEqual([]);
  });

  it("ErrorView sends rejected status, empty data and the error code", () => {
    const res = fakeRes();
    new ErrorView(res as any, 404, "entity_not_found").send();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      code: 404,
      status: "rejected",
      entry: "2026/01/01 00:00:00",
      exit: expect.any(String),
      data: [],
      error: "entity_not_found",
    });
  });

  it("adds meta from res.locals when present", () => {
    const res = fakeRes();
    res.locals.meta = { total: 3 };
    new DataView(res as any, []).send();
    expect((res.body as any).meta).toEqual({ total: 3 });
  });
});

describe("route() wrapper", () => {
  it("sends the payload in the success envelope", async () => {
    const res = fakeRes();
    await route("Test:ok", async () => ({ id: 1 }))({} as any, res as any);
    expect((res.body as any).data).toEqual([{ id: 1 }]);
    expect((res.body as any).error).toBe("");
  });

  it("sends an empty array when the handler returns undefined", async () => {
    const res = fakeRes();
    await route("Test:void", async () => undefined)({} as any, res as any);
    expect((res.body as any).data).toEqual([]);
  });

  it("renders a thrown ApiError with its own status and code, logging it as WARN", async () => {
    const con = silenceConsole();
    const res = fakeRes();
    await route("Test:api", async () => {
      throw new WidgetNotFoundError();
    })({} as any, res as any);
    expect(res.statusCode).toBe(404);
    expect((res.body as any).error).toBe("widget_not_found");
    expect(con.log.mock.calls[0][0]).toContain("WARN");
  });

  it("renders an unexpected error as 500 internal_error and logs the stack as ERROR", async () => {
    const con = silenceConsole();
    const res = fakeRes();
    await route("Test:boom", async () => {
      throw new Error("secret detail");
    })({} as any, res as any);
    expect(res.statusCode).toBe(500);
    expect((res.body as any).error).toBe("internal_error");
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
    expect(con.log.mock.calls[0][0]).toContain("ERROR");
  });

  it("does not send again when the handler returned HANDLED", async () => {
    const res = fakeRes();
    await route("Test:handled", async (_req, r) => {
      sendOk(r as any, { x: 1 }, 202);
      return HANDLED;
    })({} as any, res as any);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(202);
  });

  it("does not send an envelope when headers were already sent", async () => {
    const res = fakeRes({ headersSent: true });
    await route("Test:sent", async () => {
      throw new WidgetNotFoundError();
    })({} as any, res as any);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("sendOk writes a success envelope with the given code", () => {
    const res = fakeRes();
    expect(sendOk(res as any, [1], 201)).toBe(HANDLED);
    expect(res.statusCode).toBe(201);
    expect((res.body as any).data).toEqual([1]);
  });
});

describe("base Controller", () => {
  it("throws RouteNotDeclaredError for every verb until overridden", async () => {
    for (const verb of ["get", "post", "put", "patch", "delete"] as const) {
      await expect((Controller as any)[verb]({}, {})).rejects.toBeInstanceOf(RouteNotDeclaredError);
    }
  });
});

describe("errorHandler", () => {
  it("renders ApiError with its status and code", () => {
    const res = fakeRes();
    errorHandler(new RouteNotFoundError(), {} as any, res as any, vi.fn());
    expect(res.statusCode).toBe(404);
    expect((res.body as any).error).toBe("route_not_found");
  });

  it("maps body-parser JSON failures to 400 invalid_json", () => {
    const res = fakeRes();
    errorHandler({ type: "entity.parse.failed" } as any, {} as any, res as any, vi.fn());
    expect(res.statusCode).toBe(400);
    expect((res.body as any).error).toBe("invalid_json");
  });

  it("maps oversized bodies to 413 payload_too_large", () => {
    const res = fakeRes();
    errorHandler({ type: "entity.too.large" } as any, {} as any, res as any, vi.fn());
    expect(res.statusCode).toBe(413);
    expect((res.body as any).error).toBe("payload_too_large");
  });

  it("hides unknown errors behind a generic 500 and logs them", () => {
    const con = silenceConsole();
    const res = fakeRes();
    errorHandler(new Error("db password leaked"), {} as any, res as any, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("leaked");
    expect(con.log.mock.calls[0][0]).toContain("ERROR");
  });

  it("passes the error on when headers were already sent", () => {
    const next = vi.fn();
    const res = fakeRes({ headersSent: true });
    const err = new Error("late");
    errorHandler(err, {} as any, res as any, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("app-level envelope over HTTP", () => {
  it("returns route_not_found in the standard envelope for unknown paths", async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/does-not-exist`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(["code", "data", "entry", "error", "exit", "status"]);
      expect(body).toMatchObject({ code: 404, status: "rejected", data: [], error: "route_not_found" });
    } finally {
      await app.close();
    }
  });

  it("answers the health probe without a key", async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/health`);
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([{ online: true, db: "down" }]);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed JSON bodies with invalid_json", async () => {
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/aliases/light.a`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{oops",
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_json");
    } finally {
      await app.close();
    }
  });

  it("returns 401 for a protected route when API_TOKEN is set and no key is sent", async () => {
    process.env.API_TOKEN = "gate-key";
    const app = await startApp();
    try {
      const res = await fetch(`${app.base}/aliases`);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("missing_credentials");
      const ok = await fetch(`${app.base}/aliases`, { headers: { Authorization: "Bearer gate-key" } });
      expect(ok.status).toBe(200);
    } finally {
      process.env.API_TOKEN = "";
      await app.close();
    }
  });
});

describe("entity control validation (parseAction)", () => {
  it("accepts turn_on / turn_off / toggle with allowed params", () => {
    expect(parseAction({ action: "turn_on", params: { brightness: 200, hvac_mode: "heat" } })).toEqual({
      action: "turn_on",
      params: { brightness: 200, hvac_mode: "heat" },
    });
    expect(parseAction({ action: "toggle" })).toEqual({ action: "toggle", params: {} });
  });

  it("rejects unknown or non-string actions", () => {
    for (const action of ["reboot", 1, undefined, null]) {
      expect(() => parseAction({ action } as any)).toThrow(InvalidActionError);
    }
    expect(() => parseAction(undefined)).toThrow(InvalidActionError);
  });

  it("rejects params that are not a plain object", () => {
    for (const params of [[], "x", null, 3]) {
      if (params === null) {
        // null is treated like "absent": params default to {}.
        expect(parseAction({ action: "turn_on", params: null as any }).params).toEqual({});
        continue;
      }
      expect(() => parseAction({ action: "turn_on", params: params as any })).toThrow(InvalidParamsError);
    }
  });

  it("rejects params outside the allowlist and non-scalar values", () => {
    expect(() => parseAction({ action: "turn_on", params: { entity_id: "x" } })).toThrow(/param not allowed: entity_id/);
    expect(() => parseAction({ action: "turn_on", params: { brightness: { a: 1 } } as any })).toThrow(
      /must be a number or string/
    );
    expect(() => parseAction({ action: "turn_on", params: { brightness: true } as any })).toThrow(InvalidParamsError);
  });

  it("accepts brightness_pct and preset_mode params", () => {
    expect(parseAction({ action: "turn_on", params: { brightness_pct: 50 } }, "light").params).toEqual({
      brightness_pct: 50,
    });
    expect(parseAction({ action: "set_preset_mode", params: { preset_mode: "eco" } }, "climate").params).toEqual({
      preset_mode: "eco",
    });
  });

  it("enforces per-domain actions when a domain is given", () => {
    expect(parseAction({ action: "open_cover" }, "cover").action).toBe("open_cover");
    expect(parseAction({ action: "lock" }, "lock").action).toBe("lock");
    expect(parseAction({ action: "set_temperature", params: { temperature: 21 } }, "climate").action).toBe(
      "set_temperature"
    );
    expect(() => parseAction({ action: "open_cover" }, "light")).toThrow(InvalidActionError);
    expect(() => parseAction({ action: "turn_on" }, "lock")).toThrow(InvalidActionError);
    expect(() => parseAction({ action: "lock" }, "switch")).toThrow(InvalidActionError);
    expect(() => parseAction({ action: "set_temperature" }, "cover")).toThrow(InvalidActionError);
    expect(() => parseAction({ action: "toggle" }, "lock")).toThrow(InvalidActionError);
  });

  it("exposes the domain allowlist the panel may control", () => {
    expect(ALLOWED_DOMAINS).toContain("light");
    expect(ALLOWED_DOMAINS).toContain("lock");
    expect(ALLOWED_DOMAINS).not.toContain("sensor");
    expect(ALLOWED_ACTIONS).toEqual(expect.arrayContaining(["open_cover", "set_preset_mode", "lock", "unlock"]));
  });
});
