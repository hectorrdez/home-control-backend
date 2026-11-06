import { Router } from "express";
import AliasesController from "./AliasesController";

const routes: Router = Router();

routes.get("/aliases", AliasesController.list);
routes.put("/aliases/:entityId", AliasesController.put);
routes.delete("/aliases/:entityId", AliasesController.delete);

export default routes;
