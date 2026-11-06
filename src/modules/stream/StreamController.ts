import { Request, Response } from "express";
import Controller from "@templates/Controller";
import { route, HANDLED } from "@shared/http/route";
import { haEvents } from "./HaEvents";
import { InvalidDomainError } from "./StreamErrors";

const HEARTBEAT_MS = 25_000;
const DOMAIN_RE = /^[a-z_]+$/;

/** Reads a single query string param; repeated or missing params are ignored. */
function queryParam(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function send(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * GET /api/stream as Server-Sent Events. Auth is the normal API key gate; the
 * query token fallback for EventSource lives in apiKey.ts. Query strings are
 * never logged.
 */
export default class StreamController extends Controller {
  static stream = route("StreamController:stream", async (req, res) => {
    const domain = queryParam(req, "domain");
    if (domain !== undefined && !DOMAIN_RE.test(domain)) throw new InvalidDomainError();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    send(res, "ready", { domain: domain ?? null });

    if (req.query.once === "1") {
      res.end();
      return HANDLED;
    }

    const unsubscribe = haEvents.subscribe((entity) => {
      if (!domain || entity.domain === domain) send(res, "state_changed", entity);
    });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return HANDLED;
  });
}
