import { Request, Response } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { listCalibrations, setCalibration, deleteCalibration } from "./CalibrationsService";

export default class CalibrationsController extends Controller {
  static list = route("CalibrationsController:list", async () => listCalibrations());

  static put = route("CalibrationsController:put", async (req: Request, res: Response) =>
    setCalibration(String(req.params.entityId), req.body, res.locals.clientId ?? null)
  );

  static delete = route("CalibrationsController:delete", async (req: Request, res: Response) =>
    deleteCalibration(String(req.params.entityId), res.locals.clientId ?? null)
  );
}
