import ApiError from "./ApiError";

export default class RouteNotFoundError extends ApiError {
  constructor(msg: string = "Route not found") {
    super(msg, 404, "route_not_found");
  }
}
