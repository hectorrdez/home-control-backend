import ApiError from "./ApiError";

export default class MissingCredentialsError extends ApiError {
  constructor(msg: string = "Missing credentials") {
    super(msg, 401, "missing_credentials");
  }
}
