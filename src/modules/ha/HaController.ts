import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { haStatus } from "./HaService";

export default class HaController extends Controller {
  static status = route("HaController:status", async () => haStatus());
}
