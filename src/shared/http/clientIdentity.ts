import type { NextFunction, Request, Response } from "express";

const CLIENT_ID_RE = /^[0-9a-f-]{36}$/i;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const MAX_NAME_LENGTH = 40;

/** Returns the client id when it looks like a UUID, else null. */
export function parseClientId(raw: unknown): string | null {
  return typeof raw === "string" && CLIENT_ID_RE.test(raw) ? raw : null;
}

/** Strips control chars, trims, and returns the name when 1..40 chars remain, else null. */
export function parseClientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(CONTROL_CHARS_RE, "").trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

/**
 * Optional device identity. Sets `res.locals.clientId` / `res.locals.clientName`
 * (null when absent or invalid). Never rejects a request. `?clientId=` is read
 * only for GET /api/stream, because EventSource cannot send headers. Mount it
 * on `/api`, so `req.path` is relative to that mount.
 */
export function clientIdentity(req: Request, res: Response, next: NextFunction): void {
  let clientId = parseClientId(req.headers["x-client-id"]);
  if (clientId === null && req.method === "GET" && req.path === "/stream") {
    clientId = parseClientId(req.query.clientId);
  }
  res.locals.clientId = clientId;
  res.locals.clientName = parseClientName(req.headers["x-client-name"]);
  next();
}
