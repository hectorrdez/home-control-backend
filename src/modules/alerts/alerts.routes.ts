import { Router } from "express";
import AlertsController from "./AlertsController";

const routes: Router = Router();

routes.get("/alerts", AlertsController.list);
routes.post("/alerts/ack-all", AlertsController.ackAll);
routes.post("/alerts/:id/ack", AlertsController.ack);
// Test hook: only outside production, so the route does not exist in production (404).
if (process.env.NODE_ENV !== "production") {
  routes.post("/alerts/test-fire", AlertsController.testFire);
}

export default routes;
