import { Response } from "express";
import View from "../templates/View";

/** Success envelope. Array for lists; a single object is wrapped in a 1-item array. */
export default class DataView extends View {
  constructor(res: Response, data: unknown, code: number = 200) {
    super(res, data, code, "");
  }
}
