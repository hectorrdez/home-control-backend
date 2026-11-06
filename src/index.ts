import "dotenv/config";
import app from "./app";
import Logger from "@utils/Logger";
import { warnIfHaMisconfigured } from "@modules/ha/HaClient";
import aliasStore from "@modules/aliases/AliasStore";

const port = Number(process.env.API_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be an integer between 1 and 65535");
}
Logger.init();
warnIfHaMisconfigured();
aliasStore.load(process.env.ALIASES_FILE || "/data/aliases.json");
app.listen(port, () => Logger.write(`API listening on port ${port}`));
