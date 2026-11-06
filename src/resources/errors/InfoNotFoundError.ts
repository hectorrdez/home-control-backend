import ApiError from "./ApiError";

export default class InfoNotFoundError extends ApiError {
  constructor(msg: string = "Info not found") {
    super(msg, 404, "info_not_found");
  }
}
