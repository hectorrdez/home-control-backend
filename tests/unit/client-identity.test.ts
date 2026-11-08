import { describe, expect, it, vi } from "vitest";
import { clientIdentity, parseClientId, parseClientName } from "@shared/http/clientIdentity";

const UUID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

function run(opts: { headers?: Record<string, string>; query?: Record<string, unknown>; method?: string; path?: string }) {
  const req: any = {
    headers: opts.headers ?? {},
    query: opts.query ?? {},
    method: opts.method ?? "PUT",
    path: opts.path ?? "/aliases/light.a",
  };
  const res: any = { locals: {} };
  const next = vi.fn();
  clientIdentity(req, res, next);
  return { res, next };
}

describe("parseClientId", () => {
  it("accepts a UUID-shaped id, case-insensitive", () => {
    expect(parseClientId(UUID)).toBe(UUID);
    expect(parseClientId(UUID.toUpperCase())).toBe(UUID.toUpperCase());
  });

  it("rejects non-matching ids and non-strings", () => {
    expect(parseClientId("not-a-uuid")).toBeNull();
    expect(parseClientId(UUID + "x")).toBeNull();
    expect(parseClientId(["a"])).toBeNull();
    expect(parseClientId(undefined)).toBeNull();
  });
});

describe("parseClientName", () => {
  it("trims and keeps a normal name", () => {
    expect(parseClientName("  Tablet salon  ")).toBe("Tablet salon");
  });

  it("strips control characters before checking the length", () => {
    expect(parseClientName("Movil\u0007 juan")).toBe("Movil juan");
  });

  it("ignores a name that is empty after stripping", () => {
    expect(parseClientName("   ")).toBeNull();
    expect(parseClientName("\u0001\u0002")).toBeNull();
  });

  it("ignores a name longer than 40 chars (no truncation)", () => {
    expect(parseClientName("a".repeat(40))).toHaveLength(40);
    expect(parseClientName("a".repeat(41))).toBeNull();
  });
});

describe("clientIdentity middleware", () => {
  it("stores valid headers in res.locals and always calls next", () => {
    const { res, next } = run({ headers: { "x-client-id": UUID, "x-client-name": "Salon" } });
    expect(res.locals.clientId).toBe(UUID);
    expect(res.locals.clientName).toBe("Salon");
    expect(next).toHaveBeenCalledWith();
  });

  it("sets both to null when the headers are absent", () => {
    const { res, next } = run({});
    expect(res.locals).toEqual({ clientId: null, clientName: null });
    expect(next).toHaveBeenCalledWith();
  });

  it("ignores a bad X-Client-Id but keeps a valid name, and never errors", () => {
    const { res, next } = run({ headers: { "x-client-id": "bad", "x-client-name": "Salon" } });
    expect(res.locals.clientId).toBeNull();
    expect(res.locals.clientName).toBe("Salon");
    expect(next).toHaveBeenCalledWith();
  });

  it("accepts ?clientId= only on GET /stream", () => {
    const onStream = run({ method: "GET", path: "/stream", query: { clientId: UUID } });
    expect(onStream.res.locals.clientId).toBe(UUID);

    const onAlias = run({ method: "PUT", path: "/aliases/light.a", query: { clientId: UUID } });
    expect(onAlias.res.locals.clientId).toBeNull();

    const streamPost = run({ method: "POST", path: "/stream", query: { clientId: UUID } });
    expect(streamPost.res.locals.clientId).toBeNull();
  });

  it("prefers the header over the query param on /stream", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    const { res } = run({ method: "GET", path: "/stream", headers: { "x-client-id": UUID }, query: { clientId: other } });
    expect(res.locals.clientId).toBe(UUID);
  });

  it("ignores a non-string or invalid ?clientId= on /stream", () => {
    const { res } = run({ method: "GET", path: "/stream", query: { clientId: ["a", "b"] } });
    expect(res.locals.clientId).toBeNull();
  });
});
