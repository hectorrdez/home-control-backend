import { Request } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { listCalibrations, setCalibration, deleteCalibration } from "./CalibrationsService";

export default class CalibrationsController extends Controller {
  static list = route("CalibrationsController:list", async () => listCalibrations());

  static put = route("CalibrationsController:put", async (req: Request) =>
    setCalibration(String(req.params.entityId), req.body)
  );

  static delete = route("CalibrationsController:delete", async (req: Request) =>
    deleteCalibration(String(req.params.entityId))
  );
}
