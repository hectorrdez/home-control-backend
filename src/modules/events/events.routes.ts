import { Router } from "express";
import EventsController from "./EventsController";

const routes: Router = Router();

routes.get("/events", EventsController.list);

export default routes;
