import { Response } from "express";
import DateUtils from "../utils/Date";

/**
 * Response envelope. EVERY response (2xx and error) is this shape:
 *   { code, status, entry, exit, data, error }
 * `data` is ALWAYS a JSON array. `status` is `resolved` | `rejected`.
 * `error` is "" on success, else a stable string code (never a stack).
 * Optional additive `meta` (e.g. pagination): set `res.locals.meta`.
 * `entry` comes from `res.locals.entry` (set by the first middleware).
 */
export default class View {
  protected data: unknown[];

  constructor(
    protected res: Response,
    data: unknown,
    protected code: number = 200,
    protected error: string = ""
  ) {
    this.data = View.toArray(data);
  }

  private static toArray(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (data === null || data === undefined) return [];
    return [data];
  }

  send(): void {
    this.res.status(this.code).json({
      code: this.code,
      status: this.code >= 400 ? "rejected" : "resolved",
      entry: this.res.locals.entry ?? "",
      exit: DateUtils.obtainCurrentDateString(),
      data: this.data,
      error: this.error,
      ...(this.res.locals.meta ? { meta: this.res.locals.meta } : {}),
    });
  }
}
