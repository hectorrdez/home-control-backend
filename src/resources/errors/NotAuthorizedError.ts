import ApiError from "./ApiError";

export default class NotAuthorizedError extends ApiError {
  constructor(msg: string = "Not authorized") {
    super(msg, 403, "not_authorized");
  }
}
