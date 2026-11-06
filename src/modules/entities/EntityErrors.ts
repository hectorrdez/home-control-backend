import ApiError from "@errors/ApiError";

export class InvalidEntityIdError extends ApiError {
  constructor(msg: string = "Invalid entity id") {
    super(msg, 400, "invalid_entity_id");
  }
}

export class DomainNotAllowedError extends ApiError {
  constructor(msg: string = "Domain not allowed") {
    super(msg, 403, "domain_not_allowed");
  }
}

export class InvalidActionError extends ApiError {
  constructor(msg: string = "Invalid action") {
    super(msg, 400, "invalid_action");
  }
}

export class InvalidParamsError extends ApiError {
  constructor(msg: string = "Invalid params") {
    super(msg, 400, "invalid_params");
  }
}

export class EntityNotFoundError extends ApiError {
  constructor(msg: string = "Entity not found") {
    super(msg, 404, "entity_not_found");
  }
}
