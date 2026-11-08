import { Request, Response } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { createAlertRule, deleteAlertRule, listAlertRules, replaceAlertRule } from "./AlertRulesService";

export default class AlertRulesController extends Controller {
  static list = route("AlertRulesController:list", async (req: Request) =>
    listAlertRules(req.query.entityId === undefined ? undefined : String(req.query.entityId))
  );

  static create = route("AlertRulesController:create", async (req: Request, res: Response) =>
    createAlertRule(req.body, res.locals.clientId ?? null)
  );

  static replace = route("AlertRulesController:replace", async (req: Request, res: Response) =>
    replaceAlertRule(String(req.params.id), req.body, res.locals.clientId ?? null)
  );

  static delete = route("AlertRulesController:delete", async (req: Request, res: Response) =>
    deleteAlertRule(String(req.params.id), res.locals.clientId ?? null)
  );
}
