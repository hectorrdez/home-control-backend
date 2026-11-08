import { Request, Response } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { alertService, Actor } from "./AlertService";
import { parseAlertQuery, parseTestFireBody } from "./AlertValidation";
import { AlertNotFoundError } from "./AlertErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorOf(res: Response): Actor {
  return { clientId: res.locals.clientId ?? null, clientName: res.locals.clientName ?? null };
}

export default class AlertsController extends Controller {
  static list = route("AlertsController:list", async (req: Request) =>
    alertService.list(parseAlertQuery(req.query as Record<string, unknown>))
  );

  static ack = route("AlertsController:ack", async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) throw new AlertNotFoundError();
    return alertService.ack(id, actorOf(res));
  });

  static ackAll = route("AlertsController:ackAll", async (_req: Request, res: Response) =>
    alertService.ackAll(actorOf(res))
  );

  static testFire = route("AlertsController:testFire", async (req: Request, res: Response) =>
    alertService.testFire(parseTestFireBody(req.body), actorOf(res))
  );
}
