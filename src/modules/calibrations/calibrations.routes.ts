import { Router } from "express";
import CalibrationsController from "./CalibrationsController";

const routes: Router = Router();

routes.get("/calibrations", CalibrationsController.list);
routes.put("/calibrations/:entityId", CalibrationsController.put);
routes.delete("/calibrations/:entityId", CalibrationsController.delete);

export default routes;
