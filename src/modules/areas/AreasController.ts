import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { listAreas } from "./AreasService";

export default class AreasController extends Controller {
  static list = route("AreasController:list", async () => listAreas());
}
