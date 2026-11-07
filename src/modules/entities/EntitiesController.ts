import { Request } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { listEntities } from "./EntitiesService";
import { controlEntity, ActionBody } from "./EntitiesControlService";
import { setCoverPercent } from "@modules/covers/CoverPercentService";

/** Reads a single query string param; repeated or missing params are ignored. */
function queryParam(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export default class EntitiesController extends Controller {
  static list = route("EntitiesController:list", async (req) =>
    listEntities({ domain: queryParam(req, "domain"), area: queryParam(req, "area") })
  );

  static action = route("EntitiesController:action", async (req) =>
    controlEntity(String(req.params.entityId), req.body as ActionBody | undefined)
  );

  static coverPercent = route("EntitiesController:coverPercent", async (req) =>
    setCoverPercent(String(req.params.entityId), req.body)
  );
}
