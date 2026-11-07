import { Router } from "express";
import AlertRulesController from "./AlertRulesController";

const routes: Router = Router();

routes.get("/alert-rules", AlertRulesController.list);
routes.post("/alert-rules", AlertRulesController.create);
routes.put("/alert-rules/:id", AlertRulesController.replace);
routes.delete("/alert-rules/:id", AlertRulesController.delete);

export default routes;
