import ApiError from "./ApiError";

export default class NotEnoughDataError extends ApiError {
  constructor(msg: string = "Not enough data") {
    super(msg, 422, "not_enough_data");
  }
}
