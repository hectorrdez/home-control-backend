import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import MissingCredentialsError from "@errors/MissingCredentialsError";
import NotAuthorizedError from "@errors/NotAuthorizedError";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Service-level API key: `Authorization: <API_TOKEN>` (bare or `Bearer <key>`).
 * Disabled while `API_TOKEN` is empty (local dev). Bypass: CORS preflight and
 * `GET /health` (liveness probes must not need the key). Mounted on `/api`,
 * so `req.path` is relative to it.
 */
export function apiKeyGate(req: Request, _res: Response, next: NextFunction): void {
  const expected = process.env.API_TOKEN;
  if (!expected || req.method === "OPTIONS" || (req.method === "GET" && req.path === "/health")) {
    return next();
  }
  // EventSource cannot set headers, so the SSE stream also accepts `?token=`.
  // Only that route: a token in a query string is easier to leak elsewhere.
  const fromQuery = req.path === "/stream" && typeof req.query.token === "string" ? req.query.token : undefined;
  const given = (req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? fromQuery ?? "").trim();
  if (!given) return next(new MissingCredentialsError("Missing API key"));
  if (!same(given, expected)) return next(new NotAuthorizedError("Invalid API key"));
  next();
}
