import { Router } from "express";
import HealthController from "./HealthController";

const routes: Router = Router();

routes.get("/health", HealthController.get);

export default routes;
