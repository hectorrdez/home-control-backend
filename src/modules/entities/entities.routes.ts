import { Router } from "express";
import EntitiesController from "./EntitiesController";

const routes: Router = Router();

routes.get("/entities", EntitiesController.list);
routes.post("/entities/:entityId/action", EntitiesController.action);
routes.post("/entities/:entityId/cover-percent", EntitiesController.coverPercent);

export default routes;
