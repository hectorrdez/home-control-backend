import Controller from "@templates/Controller";
import { route } from "@shared/http/route";

/** Liveness only: does not touch MySQL. */
export default class HealthController extends Controller {
  static get = route("HealthController:get", async () => ({ online: true }));
}
