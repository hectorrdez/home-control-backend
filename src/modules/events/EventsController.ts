import { Request } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { eventLog } from "./EventLog";
import { parseEventQuery } from "./EventQuery";

export default class EventsController extends Controller {
  static list = route("EventsController:list", async (req: Request) =>
    eventLog.list(parseEventQuery(req.query as Record<string, unknown>))
  );
}
