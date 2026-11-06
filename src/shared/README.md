# src/shared

Cross-module building blocks. Anything imported by two or more modules lives
here, not inside a module folder.

- `http/route.ts`: `route(scope, fn)` wraps a handler (return payload or throw
  `ApiError`); `sendOk` / `HANDLED` for handlers that write the response.
- `db/Repository.ts`: base for module models (`many`, `one`, `exec`).
- `crypto/`: `newId`, `newToken`, `hashPassword`, `verifyPassword` (scrypt).
- `util/`: `mysqlNow*` helpers and `writeAudit` (`audit_events` table).
- `guards/apiKey.ts`: optional service-level `API_TOKEN` gate.
- `middlewares/ErrorMiddleware.ts`: final error handler.
