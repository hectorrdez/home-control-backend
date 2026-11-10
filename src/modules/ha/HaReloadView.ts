import { Response } from "express";
import View from "@templates/View";
import DateUtils from "@utils/Date";
import type { ReloadOutcome } from "./HaReloadService";

/** Standard envelope plus the `entities` counts that the reload contract adds at the top level. */
export default class HaReloadView extends View {
  constructor(
    res: Response,
    private readonly outcome: ReloadOutcome
  ) {
    super(res, outcome.data);
  }

  send(): void {
    this.res.status(this.code).json({
      code: this.code,
      status: "resolved",
      entry: this.res.locals.entry ?? "",
      exit: DateUtils.obtainCurrentDateString(),
      data: this.data,
      error: "",
      entities: this.outcome.entities,
    });
  }
}
