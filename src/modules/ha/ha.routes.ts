import { Router } from "express";
import HaController from "./HaController";

const routes: Router = Router();

routes.get("/ha/status", HaController.status);

export default routes;
