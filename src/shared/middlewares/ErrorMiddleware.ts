import { ErrorRequestHandler } from "express";
import ApiError from "@errors/ApiError";
import ErrorView from "@views/ErrorView";
import Logger from "@utils/Logger";

/** Last-resort handler: never leaks a stack, always the envelope. */
const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  let code = 500;
  let errorCode = "internal_error";
  if (error instanceof ApiError) {
    code = error.getCode();
    errorCode = error.getErrorCode();
  } else if (error && typeof error === "object" && "type" in error) {
    if (error.type === "entity.parse.failed") {
      code = 400;
      errorCode = "invalid_json";
    } else if (error.type === "entity.too.large") {
      code = 413;
      errorCode = "payload_too_large";
    }
  }
  if (code >= 500) Logger.error((error as Error)?.stack || String(error), "API:error");
  new ErrorView(res, code, errorCode).send();
};
export default errorHandler;
