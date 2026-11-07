import { Request } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { createAlertRule, deleteAlertRule, listAlertRules, replaceAlertRule } from "./AlertRulesService";

export default class AlertRulesController extends Controller {
  static list = route("AlertRulesController:list", async (req: Request) =>
    listAlertRules(req.query.entityId === undefined ? undefined : String(req.query.entityId))
  );

  static create = route("AlertRulesController:create", async (req: Request) => createAlertRule(req.body));

  static replace = route("AlertRulesController:replace", async (req: Request) =>
    replaceAlertRule(String(req.params.id), req.body)
  );

  static delete = route("AlertRulesController:delete", async (req: Request) =>
    deleteAlertRule(String(req.params.id))
  );
}
