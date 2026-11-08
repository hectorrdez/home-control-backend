import { Request, Response } from "express";
import Controller from "@templates/Controller";
import { route, HANDLED } from "@shared/http/route";
import { haEvents } from "./HaEvents";
import { InvalidDomainError } from "./StreamErrors";
import { appEvents, AppEvent } from "@shared/events/AppEvents";

const HEARTBEAT_MS = 25_000;
const DOMAIN_RE = /^[a-z_]+$/;
/** Above this many keys the event carries `keys: []`, meaning "refetch all". */
const MAX_EVENT_KEYS = 100;

/** Reads a single query string param; repeated or missing params are ignored. */
function queryParam(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function send(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Frame for an app event: `type` becomes the SSE event name, the rest is the data. */
function sendApp(res: Response, evt: AppEvent): void {
  if (evt.type === "event") {
    send(res, "event", evt.event);
    return;
  }
  if (evt.type === "ha_link") {
    send(res, "ha_link", { connected: evt.connected, at: evt.at });
    return;
  }
  const { type, ...rest } = evt;
  const keys = rest.keys.length > MAX_EVENT_KEYS ? [] : rest.keys;
  send(res, type, { ...rest, keys });
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
    // App events are not entity events, so the domain filter does not apply to them.
    const unsubscribeApp = appEvents.subscribe((evt) => sendApp(res, evt));
    // Current HA link state for this client (019); same tick as the subscribe, so no transition is missed.
    const link = haEvents.status;
    send(res, "ha_link", { connected: link.connected, at: link.at });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeApp();
    });
    return HANDLED;
  });
}
