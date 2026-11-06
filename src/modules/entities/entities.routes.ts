import { Router } from "express";
import EntitiesController from "./EntitiesController";

const routes: Router = Router();

routes.get("/entities", EntitiesController.list);

export default routes;
