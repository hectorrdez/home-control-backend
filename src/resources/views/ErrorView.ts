import { Response } from "express";
import View from "../templates/View";

/** Error envelope: `data` is `[]`, `error` a stable string code (e.g. `route_not_found`). */
export default class ErrorView extends View {
  constructor(res: Response, code: number, error: string) {
    super(res, [], code, error);
  }
}
