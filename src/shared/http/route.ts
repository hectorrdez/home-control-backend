import { Request, Response } from "express";
import ApiError from "@errors/ApiError";
import DataView from "@views/DataView";
import ErrorView from "@views/ErrorView";
import Logger from "@utils/Logger";

/** Return this from a handler that already wrote the response (e.g. set-cookie flows). */
export const HANDLED = Symbol("response-already-sent");

export type RouteFn = (req: Request, res: Response) => Promise<unknown>;

/**
 * Wrap a module handler. The handler returns the payload (array for lists, a
 * single object for one resource, `[]` for empty) or throws an `ApiError`.
 * Everything is rendered as the standard envelope; thrown errors never leak a
 * stack. Return `HANDLED` when the handler sent the response itself.
 */
export function route(scope: string, fn: RouteFn) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const out = await fn(req, res);
      if (out === HANDLED || res.headersSent) return;
      new DataView(res, out ?? []).send();
    } catch (err) {
      const isApi = err instanceof ApiError;
      if (isApi) {
        Logger.write(err.getMessage(), scope, "WARN");
      } else {
        Logger.error((err as Error)?.stack || String(err), scope);
      }
      if (res.headersSent) return;
      new ErrorView(
        res,
        isApi ? err.getCode() : 500,
        isApi ? err.getErrorCode() : "internal_error"
      ).send();
    }
  };
}

/** Send a success envelope from inside a handler (then `return HANDLED`). */
export function sendOk(res: Response, data: unknown, code = 200): typeof HANDLED {
  new DataView(res, data, code).send();
  return HANDLED;
}
