import ApiError from "@errors/ApiError";

/** Any bad `GET /api/events` query parameter. The message names the parameter. */
export class InvalidQueryError extends ApiError {
  constructor(msg: string = "Invalid query") {
    super(msg, 400, "invalid_query");
  }
}
