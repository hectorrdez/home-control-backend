import ApiError from "@errors/ApiError";

/** `?domain=` is not a plain HA domain name. */
export class InvalidDomainError extends ApiError {
  constructor(msg: string = "Invalid domain filter") {
    super(msg, 400, "invalid_domain");
  }
}
