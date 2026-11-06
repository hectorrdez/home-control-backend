import "dotenv/config";
import app from "./app";
import Logger from "@utils/Logger";

const port = Number(process.env.API_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be an integer between 1 and 65535");
}
Logger.init();
app.listen(port, () => Logger.write(`API listening on port ${port}`));
