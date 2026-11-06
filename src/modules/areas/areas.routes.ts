import { Router } from "express";
import AreasController from "./AreasController";

const routes: Router = Router();

routes.get("/areas", AreasController.list);

export default routes;
