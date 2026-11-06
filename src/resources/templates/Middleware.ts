import { NextFunction, Request, Response } from "express";
import MethodNotImplementedError from "../errors/MethodNotImplementedError";

export default class Middleware {
  public static handle(_req: Request, _res: Response, _next: NextFunction): void {
    throw new MethodNotImplementedError();
  }
}
