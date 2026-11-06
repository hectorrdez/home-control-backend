import { Request, Response } from "express";
import RouteNotDeclaredError from "../errors/RouteNotDeclaredError";

/**
 * Base controller: every verb throws until a subclass overrides it. Override
 * with `static get = route("Name:get", async (req, res) => payload)` from
 * `@shared/http/route`, which also catches async errors for Express 4.
 */
export default class Controller {
  static async get(_req: Request, _res: Response): Promise<unknown> {
    throw new RouteNotDeclaredError();
  }
  static async post(_req: Request, _res: Response): Promise<unknown> {
    throw new RouteNotDeclaredError();
  }
  static async put(_req: Request, _res: Response): Promise<unknown> {
    throw new RouteNotDeclaredError();
  }
  static async patch(_req: Request, _res: Response): Promise<unknown> {
    throw new RouteNotDeclaredError();
  }
  static async delete(_req: Request, _res: Response): Promise<unknown> {
    throw new RouteNotDeclaredError();
  }
}
