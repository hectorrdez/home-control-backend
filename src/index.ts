import "dotenv/config";
import app from "./app";
import Logger from "@utils/Logger";
import { warnIfHaMisconfigured } from "@modules/ha/HaClient";
import aliasStore from "@modules/aliases/AliasStore";
import calibrationStore from "@modules/calibrations/CalibrationStore";
import alertRuleStore from "@modules/alert-rules/AlertRuleStore";
import settingStore from "@modules/settings/SettingStore";
import { pool } from "./db/pool";
import { connectDb } from "./db/connect";
import { migrate } from "./db/migrate";
import { startDbPing } from "./db/health";
import { startConfigChangedRecorder } from "@modules/events/EventLog";
import { startEventRetention } from "@modules/events/EventRetention";

const port = Number(process.env.API_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be an integer between 1 and 65535");
}
Logger.init();
warnIfHaMisconfigured();

// Database first: the stores and the listener only start once the schema is ready.
// Any failure exits so compose restarts the container.
async function bootstrap(): Promise<void> {
  await connectDb(pool);
  await migrate(pool);
  startDbPing(pool);
  // Legacy JSON files are imported once (only into an empty collection) and renamed to .imported-*.
  await aliasStore.load();
  await aliasStore.importLegacy(process.env.ALIASES_FILE || "/data/aliases.json");
  await calibrationStore.load();
  await calibrationStore.importLegacy(process.env.CALIBRATIONS_FILE || "/data/calibrations.json");
  await alertRuleStore.load();
  await alertRuleStore.importLegacy(process.env.ALERT_RULES_FILE || "/data/alert-rules.json");
  // Settings are new in 017: no legacy JSON file to import.
  await settingStore.load();
  // Event log (018): config_changed recorder on the bus, plus the retention job.
  startConfigChangedRecorder();
  startEventRetention();
  app.listen(port, () => Logger.write(`API listening on port ${port}`));
}

bootstrap().catch((err: Error) => {
  Logger.error(`startup failed: ${err.message}`);
  process.exit(1);
});
