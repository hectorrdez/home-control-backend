import ApiError from "./ApiError";

export default class DataNotFoundError extends ApiError {
  constructor(msg: string = "Requested data not found") {
    super(msg, 404, "data_not_found");
  }
}
