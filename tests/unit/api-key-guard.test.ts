import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiKeyGate } from "@shared/guards/apiKey";
import MissingCredentialsError from "@errors/MissingCredentialsError";
import NotAuthorizedError from "@errors/NotAuthorizedError";

const KEY = "s3cret-key-value";

function req(opts: { method?: string; path?: string; auth?: string; query?: Record<string, unknown> }) {
  return {
    method: opts.method ?? "GET",
    path: opts.path ?? "/entities",
    headers: opts.auth === undefined ? {} : { authorization: opts.auth },
    query: opts.query ?? {},
  } as any;
}

function run(r: ReturnType<typeof req>) {
  const next = vi.fn();
  apiKeyGate(r, {} as any, next);
  return next.mock.calls[0]?.[0];
}

beforeEach(() => {
  process.env.API_TOKEN = KEY;
});

afterEach(() => {
  process.env.API_TOKEN = "";
});

describe("apiKeyGate", () => {
  it("is disabled while API_TOKEN is empty", () => {
    process.env.API_TOKEN = "";
    const next = vi.fn();
    apiKeyGate(req({}), {} as any, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("lets CORS preflight through without a key", () => {
    expect(run(req({ method: "OPTIONS", path: "/entities" }))).toBeUndefined();
  });

  it("lets GET /health through without a key, but not other methods on it", () => {
    expect(run(req({ path: "/health" }))).toBeUndefined();
    expect(run(req({ method: "POST", path: "/health" }))).toBeInstanceOf(MissingCredentialsError);
  });

  it("rejects a request with no credentials with MissingCredentialsError (401)", () => {
    const err = run(req({}));
    expect(err).toBeInstanceOf(MissingCredentialsError);
    expect(err.getCode()).toBe(401);
    expect(err.getErrorCode()).toBe("missing_credentials");
  });

  it("accepts the bare key and the Bearer form", () => {
    expect(run(req({ auth: KEY }))).toBeUndefined();
    expect(run(req({ auth: `Bearer ${KEY}` }))).toBeUndefined();
    expect(run(req({ auth: `bearer ${KEY}` }))).toBeUndefined();
  });

  it("rejects a wrong key with NotAuthorizedError (403), including keys of other lengths", () => {
    for (const bad of ["wrong", `${KEY}x`, KEY.slice(1), `Bearer nope`]) {
      const err = run(req({ auth: bad }));
      expect(err).toBeInstanceOf(NotAuthorizedError);
      expect(err.getCode()).toBe(403);
      expect(err.getErrorCode()).toBe("not_authorized");
    }
  });

  it("handles keys of different lengths without throwing (constant-time compare needs equal lengths)", () => {
    expect(run(req({ auth: "short" }))).toBeInstanceOf(NotAuthorizedError);
    expect(run(req({ auth: "x".repeat(200) }))).toBeInstanceOf(NotAuthorizedError);
  });

  it("accepts ?token= only on the stream route", () => {
    expect(run(req({ path: "/stream", query: { token: KEY } }))).toBeUndefined();
    expect(run(req({ path: "/entities", query: { token: KEY } }))).toBeInstanceOf(MissingCredentialsError);
    expect(run(req({ path: "/aliases", query: { token: KEY } }))).toBeInstanceOf(MissingCredentialsError);
  });

  it("rejects a wrong ?token= on the stream route", () => {
    expect(run(req({ path: "/stream", query: { token: "nope" } }))).toBeInstanceOf(NotAuthorizedError);
  });

  it("ignores a non-string ?token=", () => {
    expect(run(req({ path: "/stream", query: { token: ["a", "b"] } }))).toBeInstanceOf(MissingCredentialsError);
  });
});
