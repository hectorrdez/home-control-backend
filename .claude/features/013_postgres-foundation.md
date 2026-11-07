---
id: "013"
slug: postgres-foundation
title: Postgres in the compose stack, pool, migrations, db health
role: backend
type: change
extends: "006"
---

# Postgres in the compose stack, pool, migrations, db health

## Description
First step of the persistence decision (2026-11-07): the API stops being a single container and runs as a docker compose STACK `api + db` (PostgreSQL 17). This feature only adds the database plumbing: the `db` service, a connection pool, a tiny SQL migration runner with the initial schema, and a `db` flag on `/api/health`. No existing store moves yet (014 does that). Replaces the "no database" line of 006 / project.md.

## Decisions (refined 2026-11-07, Opus)
- ONE engine: PostgreSQL 17 (`postgres:17-alpine`). No TimescaleDB (sensor time series stay in HA's recorder, read through 007), no Redis (single API replica, in-process fan-out), no Mongo (`jsonb` covers documents).
- Driver `pg` (node-postgres) + `@types/pg`. No ORM, no query builder. `pg` reads the standard `PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE` env vars natively: do not invent a `DATABASE_URL`.
- Migrations = TypeScript files exporting SQL strings (tsc builds them; no `.sql` copy step).

## Requirements
- `npm i pg` and `npm i -D @types/pg` (exact versions in package-lock).
- `src/db/pool.ts`: one shared `Pool` (`max` from `DB_POOL_MAX`, default 5; `idleTimeoutMillis` 30000; `connectionTimeoutMillis` 5000). Export `pool`, `query(sql, params)` and `withTransaction(fn)` (BEGIN/COMMIT, ROLLBACK on throw, client always released). Export a minimal `Queryable` interface `{ query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }` so later stores can be unit-tested with fakes. Never log connection strings or `PGPASSWORD`; pool `error` events -> `Logger.error` with the message only.
- `src/db/migrations/index.ts`: ordered array `{ version: number, name: string, up: string }`. `src/db/migrations/001_init.ts` creates:
  - `schema_migrations(version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`
  - `documents(collection text NOT NULL, key text NOT NULL, value jsonb NOT NULL, version int NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text NULL, PRIMARY KEY (collection, key))` (generic keyed documents: aliases, calibrations, alert rules, settings)
  - `events(id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), type text NOT NULL, source text NOT NULL, client_id text NULL, client_name text NULL, entity_id text NULL, level text NULL, payload jsonb NOT NULL DEFAULT '{}')` + indexes `events_ts_idx (ts DESC)`, `events_type_ts_idx (type, ts DESC)`, `events_entity_ts_idx (entity_id, ts DESC)`
  - `alerts(id uuid PRIMARY KEY, rule_id uuid NULL, entity_id text NOT NULL, level text NOT NULL, text text NOT NULL, fired_at timestamptz NOT NULL DEFAULT now(), acked_at timestamptz NULL, acked_by text NULL)` + index `alerts_open_idx (fired_at DESC) WHERE acked_at IS NULL`
- `src/db/migrate.ts` `migrate(db)`: creates `schema_migrations` if missing, takes `pg_advisory_lock(4210013)`, applies every migration with version > max applied, each in its own transaction (SQL + insert into `schema_migrations`), releases the lock. A failing migration rolls back, logs `migration <version> <name> failed` and throws. Applied twice -> no-op.
- `src/db/connect.ts` `connectDb()`: `SELECT 1` with retry 1s, 2s, 4s, 8s, 15s, 30s (total ~60s); still failing -> throw. `src/index.ts`: `await connectDb(); await migrate(pool);` BEFORE the stores load and before `app.listen`; any failure -> `Logger.error` + `process.exit(1)` (compose restarts it).
- Track liveness: `src/db/health.ts` keeps `dbUp` (true after a successful query, false on pool error or failed ping); ping every 30 s with `SELECT 1`.
- `GET /api/health` -> `{ data: [{ online: true, db: "up" | "down" }] }`. Status stays 200 also when db is down (liveness only, Docker healthcheck must not loop-restart on a db blip).
- `docker/compose.yaml`: add service `db` (`image: postgres:17-alpine`, `restart: unless-stopped`, env `POSTGRES_DB: ${POSTGRES_DB:-homecontrol}`, `POSTGRES_USER: ${POSTGRES_USER:-homecontrol}`, `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}`, `command: ["postgres","-c","shared_buffers=32MB","-c","max_connections=20","-c","work_mem=4MB"]`, volume `pg-data:/var/lib/postgresql/data`, healthcheck `pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}` interval 10s timeout 5s retries 6 start_period 20s, NO published port). `api` gets `depends_on: { db: { condition: service_healthy } }` and env `PGHOST: db`, `PGPORT: "5432"`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` mapped from the POSTGRES_* vars, `DB_POOL_MAX`. Volumes get explicit names: `pg-data: { name: ${PG_VOLUME_NAME:-home-control-pg} }`, the existing `/data` volume `name: ${DATA_VOLUME_NAME:-home-control-data}` (prod sets `DATA_VOLUME_NAME=home-control-aliases` so 014 can import the old JSON files). Keep `PUBLISH_PORT` (prod 3041).
- New `docker/compose.local.yaml` (override for Docker Desktop): publishes `db` on `127.0.0.1:${PG_PUBLISH_PORT:-5432}:5432` (for `npm run dev` on the host) and nothing else. Usage in README: full stack `docker compose -f docker/compose.yaml -f docker/compose.local.yaml --env-file .env up -d --build`; db only for `npm run dev`: same command + `db` at the end, with `PGHOST=localhost` in `.env`.
- `.env.example`: add `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD=` (empty, "never commit"), `PGHOST=localhost`, `PGPORT=5432`, `PGDATABASE`, `PGUSER`, `PGPASSWORD=` (same value as POSTGRES_PASSWORD), `DB_POOL_MAX=5`, `PG_PUBLISH_PORT=5432`. README section "Stack (api + db)". Real values only in the gitignored `.env` and in Dokploy env.
- Record with `add-note.cjs`: persistence decision (Postgres approved, supersedes the "no database" scope line and the 008/010/012 JSON-only exceptions once 014 lands), PG* env names, migration file convention, test precondition (db must be up).

## Touches existing endpoints
yes: `GET /api/health` gains `db` (additive; `online` unchanged). Update `endpoints.md` row and the Bruno health request.

## Done when
**Unit (vitest)**
- `migrate` with a fake `Queryable`: applies pending migrations in version order, each inside BEGIN/COMMIT, records them; second run applies nothing; a failing migration issues ROLLBACK, throws, and later migrations are not run; advisory lock taken and released (also on failure).
- `connectDb` retries then succeeds; gives up after the schedule (fake timers).
- `withTransaction` rolls back and releases the client when `fn` throws.
- health controller returns `db: "down"` when the flag is false, still 200.

**Bruno**
- `tests/bruno/health/health.bru`: 200, `data[0].online === true`, `data[0].db === "up"`.
- Whole existing collection still green against the stack (`test.cjs` precondition: db + API running; local: compose `up -d db` + `npm run dev`).

**E2E / manual (orchestrator, Docker Desktop)**
- `docker compose -f docker/compose.yaml -f docker/compose.local.yaml --env-file .env up -d --build` -> both services `healthy`; `docker compose ... restart api` keeps the data (`schema_migrations` row 1 present); stopping `db` -> health shows `db: "down"`, API keeps serving HA routes.
- test.cjs green.
