import { Router } from "express";
import PresetsController from "./PresetsController";

const routes: Router = Router();

routes.get("/presets", PresetsController.list);
routes.post("/presets", PresetsController.create);
routes.put("/presets/:id", PresetsController.replace);
routes.delete("/presets/:id", PresetsController.delete);
routes.post("/presets/:id/apply", PresetsController.apply);

export default routes;
