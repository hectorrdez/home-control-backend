# src/shared

Cross-module building blocks. Anything imported by two or more modules lives
here, not inside a module folder.

- `http/route.ts`: `route(scope, fn)` wraps a handler (return payload or throw
  `ApiError`); `sendOk` / `HANDLED` for handlers that write the response.
- `guards/apiKey.ts`: optional service-level `API_TOKEN` gate.
- `middlewares/ErrorMiddleware.ts`: final error handler.
