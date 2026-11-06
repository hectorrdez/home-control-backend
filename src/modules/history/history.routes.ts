import { Router } from "express";
import HistoryController from "./HistoryController";

const routes: Router = Router();

routes.get("/history", HistoryController.history);

export default routes;
