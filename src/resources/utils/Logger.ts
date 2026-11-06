import fs from "fs";
import Console from "./Console";
import DateUtils from "./Date";

/**
 * Console logger; also appends CSV files under `data/logs` and `data/errors`
 * when `LOG_TO_FILE=true` (off by default: container filesystems are read-only
 * for the `node` user). Call `Logger.init()` once at startup.
 */
export default class Logger {
  private static logFile = "";
  private static errorFile = "";

  public static init(): void {
    if (process.env.LOG_TO_FILE !== "true") return;
    fs.mkdirSync("data/logs", { recursive: true });
    fs.mkdirSync("data/errors", { recursive: true });
    const stamp = DateUtils.obtainCurrentDateString().replace(/[/: ]/g, "_");
    Logger.logFile = `data/logs/${stamp}.csv`;
    Logger.errorFile = `data/errors/${stamp}.csv`;
    const header = "timestamp|scope|type|content\n";
    fs.writeFileSync(Logger.logFile, header);
    fs.writeFileSync(Logger.errorFile, header);
  }

  public static write(text: string, scope: string = "API", type: string = "INFO"): void {
    const now = DateUtils.obtainCurrentDateString();
    if (Logger.logFile) fs.appendFileSync(Logger.logFile, `${now}|${scope}|${type}|${text}\n`);
    Console.write(`[${now}][${scope}]${type}: ${text}`);
  }

  public static error(text: string, scope: string = "API"): void {
    if (Logger.errorFile) {
      fs.appendFileSync(Logger.errorFile, `${DateUtils.obtainCurrentDateString()}|${scope}|ERROR|${text}\n`);
    }
    Logger.write(text, scope, "ERROR");
  }
}
