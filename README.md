# API

Express + TypeScript + MySQL, organized by domain modules. Requires Node.js 22+
and npm. The initial health endpoint runs without a database.

```sh
npm install
cp .env.example .env
npm run dev
```

In PowerShell, use `Copy-Item .env.example .env` for the copy step.
`GET http://localhost:3002/api/health` returns 200 with `data[0].online: true`
(liveness only, not a database check).

```sh
npm run typecheck
npm run build
npm start
npm run new:module <name>   # scaffolds src/modules/<name> and registers it
```

Commit the generated `package-lock.json`; subsequent installs use `npm ci`.

## Structure

- `src/index.ts`, `src/app.ts`: bootstrap, CORS, API key gate, error handling.
- `src/routes.ts`: aggregator mounted under `/api`; mounts each module router.
- `src/modules/<name>/`: `<name>.routes.ts`, `<Name>Controller.ts`, `<Name>Model.ts`.
- `src/shared/`: cross-module code (see `src/shared/README.md`): `route()` handler
  wrapper, `Repository`, crypto, time helpers, audit, guards, error middleware.
- `src/resources/`: base templates (`Controller`, `Entity`, `Middleware`,
  `Model`, `View`), `views/` (`DataView`, `ErrorView`), typed `errors/`, and
  `utils/` (`Connection` pool with `transaction()`, `Logger`, `Date`, `Mailer`).
- `db/`: `schema.sql` and `seed.sql` (see `db/README.md`).
- `docker/`: `compose.yaml` (local) and `compose.prod.yaml` (deploy).

## Writing an endpoint

```ts
// modules/invoices/InvoicesController.ts
static get = route("InvoicesController:get", async (req) => {
  const row = await model.byId(req.params.id);
  if (!row) throw new DataNotFoundError();
  return row;                        // object, array or [] -> envelope
});
```

Handlers return the payload or throw an `ApiError` subclass; `route()` renders
the envelope. Models extend `Repository` (`many` / `one` / `exec`) with
parameterized SQL; use `db.transaction(fn)` for multi-statement writes.

## Response envelope

Every response, success or error, is
`{ code, status, entry, exit, data, error }`: `data` is always an array,
`status` is `resolved` | `rejected`, and `error` is `""` or a stable snake_case
code (`route_not_found`, `invalid_json`, `internal_error`, ...), never a stack.
Set `res.locals.meta` for an additive `meta` (e.g. pagination). Unexpected
errors are logged server-side and return a generic 500.

## Configuration

- `API_TOKEN`: if set, `/api/*` requires `Authorization: <API_TOKEN>` (bare or
  `Bearer`), except `GET /api/health`. Empty disables the gate (local dev).
- `CORS_ORIGINS`: comma-separated allowlist; empty reflects any Origin (dev).
- `LOG_TO_FILE=true`: also writes CSV logs under `data/`.
- `EMAIL_*`: SMTP settings for `Mailer`; not needed otherwise.
- Projects created with auth also use `SESSION_*` and `COOKIE_*` (see `.env.example`).

## Local MySQL and Docker

Set `DB_PASS` and `DB_ROOT_PASS` to your own values in `.env` first.
From the project root, start only the database for local development:

```sh
docker compose --env-file .env -f docker/compose.yaml up -d db
```

Or run the API and database together (run `npm install` first to create the lockfile):

```sh
docker compose --env-file .env -f docker/compose.yaml up --build -d
```

SQL files in `db/` run only when MySQL initializes a new data volume.
`docker/compose.prod.yaml` is the deploy variant: config from the platform's
environment, DB not published, `API_TOKEN` required.
