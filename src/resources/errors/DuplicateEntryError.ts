import ApiError from "./ApiError";

export default class DuplicateEntryError extends ApiError {
  constructor(msg: string = "Duplicate entry") {
    super(msg, 409, "duplicate_entry");
  }
}
