import { Request } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { listEntities } from "./EntitiesService";
import { controlEntity, ActionBody } from "./EntitiesControlService";
import { setCoverPercent } from "@modules/covers/CoverPercentService";
import { recordEntityAction } from "@modules/events/ActionRecorder";

/** Reads a single query string param; repeated or missing params are ignored. */
function queryParam(req: Request, key: string): string | undefined {
  const v = req.query[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export default class EntitiesController extends Controller {
  static list = route("EntitiesController:list", async (req) =>
    listEntities({ domain: queryParam(req, "domain"), area: queryParam(req, "area") })
  );

  static action = route("EntitiesController:action", async (req, res) => {
    const entityId = String(req.params.entityId);
    const body = req.body as ActionBody | undefined;
    const params = body?.params;
    const isObject = typeof params === "object" && params !== null && !Array.isArray(params);
    return recordEntityAction(
      res,
      {
        entityId,
        action: typeof body?.action === "string" ? body.action : null,
        params: isObject ? (params as Record<string, unknown>) : undefined,
      },
      () => controlEntity(entityId, body)
    );
  });

  static coverPercent = route("EntitiesController:coverPercent", async (req, res) => {
    const entityId = String(req.params.entityId);
    const body = (req.body !== null && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    return recordEntityAction(res, { entityId, action: "cover_percent", params: { percent: body.percent } }, () =>
      setCoverPercent(entityId, req.body)
    );
  });
}
