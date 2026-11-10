import Controller from "@templates/Controller";
import { route, HANDLED } from "@shared/http/route";
import { haStatus } from "./HaService";
import HaReloadView from "./HaReloadView";
import { ReloadCooldownError } from "./HaReloadErrors";
import { configuredReloadDomains, reloadGate, reloadHaIntegrations } from "./HaReloadService";

export default class HaController extends Controller {
  static status = route("HaController:status", async () => haStatus());

  static reload = route("HaController:reload", async (_req, res) => {
    const domains = configuredReloadDomains();
    try {
      reloadGate.acquire();
    } catch (err) {
      if (err instanceof ReloadCooldownError) {
        res.locals.meta = { retryAfterSeconds: err.retryAfterSeconds };
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
      }
      throw err;
    }
    try {
      const outcome = await reloadHaIntegrations(domains, res.locals.clientId ?? null);
      new HaReloadView(res, outcome).send();
      return HANDLED;
    } finally {
      reloadGate.release();
    }
  });
}
