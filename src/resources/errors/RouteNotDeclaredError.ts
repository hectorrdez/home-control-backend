import ApiError from "./ApiError";

export default class RouteNotDeclaredError extends ApiError {
  constructor(msg: string = "Route not declared") {
    super(msg, 500, "route_not_declared");
  }
}
