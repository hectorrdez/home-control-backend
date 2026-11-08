import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { isDbUp } from "@db/health";
import { haCache } from "@modules/ha/HaCache";

/**
 * Liveness only: always 200 so the Docker healthcheck never restart-loops on a
 * database blip. `db` reports the pool's last known state.
 */
export default class HealthController extends Controller {
  static get = route("HealthController:get", async () => ({
    online: true,
    db: isDbUp() ? "up" : "down",
    haCache: haCache.status(),
  }));
}
