import { Router } from "express";
import SettingsController from "./SettingsController";

const routes: Router = Router();

routes.get("/settings", SettingsController.list);
routes.get("/settings/:key", SettingsController.get);
routes.put("/settings/:key", SettingsController.put);
routes.delete("/settings/:key", SettingsController.delete);

export default routes;
