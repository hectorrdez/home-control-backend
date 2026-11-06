import { Router } from "express";
import StreamController from "./StreamController";

const routes: Router = Router();

routes.get("/stream", StreamController.stream);

export default routes;
