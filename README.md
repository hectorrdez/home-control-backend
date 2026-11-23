# Home Control Backend

A TypeScript + Express API that sits in front of [Home Assistant](https://www.home-assistant.io/), adding a stable, authenticated interface for controlling entities, browsing areas, streaming state changes and keeping history, with PostgreSQL for persistence.

![Node](https://img.shields.io/badge/Node-22-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)
![Vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)
![Bruno](https://img.shields.io/badge/API%20tests-Bruno-5C2D91)

## Features

- **Entities and areas**: list Home Assistant entities (filter by domain), control them with validated actions, and browse them grouped by area.
- **Live stream**: Server-Sent Events endpoint that pushes state changes to the frontend.
- **History**: query recorded entity history and events.
- **Aliases**: user-defined display names for entities, persisted in PostgreSQL.
- **Calibrations**: per-entity calibration settings (for example, cover travel timing used for percentage positioning).
- **Alert rules and alerts**: rules that trigger alerts on entity state, with acknowledgement.
- **Presets, settings and event log**: stored presets, runtime settings, and an event log with configurable retention.
- **Home Assistant integration**: whitelisted integration reloads and per-request timeouts with a safe retry policy for reads.

## Quick start

Requires Node.js 22+ and npm.

```sh
npm install
cp .env.example .env     # PowerShell: Copy-Item .env.example .env
npm run dev              # ts-node-dev with hot reload
```

Fill in `.env` with your Home Assistant URL and long-lived access token. Leave `API_TOKEN` empty only for local development; it is required in production.

### npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Run the API from source with auto-reload. |
| `npm run typecheck` | Type-check with `tsc --noEmit`. |
| `npm run build` | Compile to `dist/` and resolve path aliases. |
| `npm start` | Run the compiled build (`node dist/index.js`). |
| `npm run test:unit` | Run the Vitest unit suite. |
| `npm run test:unit:cov` | Run the unit suite with V8 coverage. |

## Configuration

All configuration comes from environment variables. See [`.env.example`](.env.example) for the full list with comments. The main ones:

| Variable | Notes |
|---|---|
| `API_PORT` | Listen port (default `3002`). |
| `HA_URL` | Home Assistant base URL, e.g. `http://<HA_HOST>:8123`. |
| `HA_TOKEN` | Home Assistant long-lived access token. Never expose it to the frontend. |
| `HA_RELOAD_DOMAINS` | Integrations that `POST /api/ha/reload` may reload. Empty disables the endpoint. |
| `HA_TIMEOUT_MS` | Per-request timeout to Home Assistant (1000–30000, default `5000`). |
| `API_TOKEN` | Bearer token required on `/api/*` except `GET /api/health`. Empty disables the gate (local dev only). |
| `CORS_ORIGINS` | Comma-separated origin allowlist, e.g. `https://home.example.com,http://localhost:5173`. |
| `POSTGRES_*` / `PG*` | Database connection (see the Docker section). |
| `LOG_TO_FILE` | `true` also writes CSV logs under `data/`. |

## Architecture

### Layout

- `src/index.ts`, `src/app.ts`: bootstrap, CORS, API key gate, error handling.
- `src/routes.ts`: aggregator mounted under `/api`.
- `src/modules/<name>/`: one domain per folder: `health`, `ha`, `entities`, `areas`, `stream`, `history`, `aliases`, `calibrations`, `alert-rules`, `alerts`, `covers`, `presets`, `settings`, `events`.
- `src/shared/`: route wrapper, guards and error middleware.
- `src/resources/`: controller/view templates, typed errors and utilities.
- `src/db/`: shared `pg` pool, startup connection retry, migrations (TypeScript files exporting SQL) and the database liveness flag.

### Response envelope

Every response uses the same shape:

```json
{ "code": 200, "status": "resolved", "entry": "...", "exit": "...", "data": [], "error": "" }
```

`data` is always an array. `status` is `resolved` or `rejected`. `error` is an empty string or a stable snake_case code; stack traces are never returned.

### Health

`GET /api/health` is an unauthenticated liveness check. It returns `200` with `data[0].online: true`, and reports `db: "up" | "down"` while staying `200` even when the database is down.

## Docker

`docker/compose.yaml` runs the API and PostgreSQL 17 (`postgres:17-alpine`). The database has no published port; only the API reaches it on the compose network. Migrations run at startup before the listener opens.

```sh
# Full stack (Docker Desktop, with the db published on 127.0.0.1)
docker compose -f docker/compose.yaml -f docker/compose.local.yaml --env-file .env up -d --build

# Database only, for `npm run dev` on the host (set PGHOST=localhost in .env)
docker compose -f docker/compose.yaml -f docker/compose.local.yaml --env-file .env up -d db
```

- `POSTGRES_PASSWORD` lives only in the git-ignored `.env` (or your deployment's secret store). Never commit it.
- The `db-backup` service writes a nightly `pg_dump` (custom format) to a volume and keeps the newest `BACKUP_KEEP` dumps.
- `docker compose ... down` keeps data; `down -v` deletes the database and the backups.
- `docker/Dockerfile` is a multi-stage Node 22 build using `npm ci`.

Aliases, calibrations and alert rules are stored in the PostgreSQL `documents` table. The legacy JSON files (`ALIASES_FILE`, `CALIBRATIONS_FILE`, `ALERT_RULES_FILE`) are only imported once, on first start, when the matching collection is empty.

## API testing

- **Bruno collections** live in [`tests/bruno/`](tests/bruno), one folder per resource (entities, areas, aliases, calibrations, alerts, alert-rules, stream, and others). Environments are in `tests/bruno/environments/`; set `baseUrl` there to point at your instance. Run them with the Bruno CLI:

  ```sh
  npx bru run tests/bruno --env local
  ```

- **Unit tests** live in [`tests/unit/`](tests/unit) and run with Vitest:

  ```sh
  npm run test:unit
  npm run test:unit:cov   # with coverage
  ```

## Frontend

The companion panel is [home-control-frontend](https://github.com/hectorrdez/home-control-frontend).
