import ApiError from "./ApiError";

export default class MethodNotImplementedError extends ApiError {
  constructor(msg: string = "Method not implemented") {
    super(msg, 501, "method_not_implemented");
  }
}
