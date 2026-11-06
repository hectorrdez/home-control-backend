import { Request } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { fetchHistory, parseEntityIds, parseHours } from "./HistoryService";

/** Reads a single query string param; repeated or missing params are ignored. */
function queryParam(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export default class HistoryController extends Controller {
  static history = route("HistoryController:history", async (req) =>
    fetchHistory(parseEntityIds(queryParam(req, "entityIds")), parseHours(queryParam(req, "hours")))
  );
}
