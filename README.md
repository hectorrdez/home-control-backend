# Home Control API

Express + TypeScript API in front of Home Assistant (list/control entities,
areas, SSE stream, history). PostgreSQL 17 (compose service `db`) for persistence. Node.js 22+ and npm.

```sh
npm install
cp .env.example .env     # PowerShell: Copy-Item .env.example .env
npm run dev
npm run typecheck
npm run build && npm start
```

`GET /api/health` returns 200 with `data[0].online: true` (liveness only,
no auth). Contract: `.claude/endpoints.md`.

## Structure

- `src/index.ts`, `src/app.ts`: bootstrap, CORS, API key gate, error handling.
- `src/routes.ts`: aggregator mounted under `/api`.
- `src/modules/<name>/`: `health`, `ha`, `entities`, `areas`, `stream`, `history`, `aliases`, `calibrations`, `alert-rules`.
- `src/shared/`: `route()` wrapper, guards, error middleware.
- `src/resources/`: controller/view templates, typed `errors/`, `utils/`.
- `src/db/`: `pool.ts` (shared `pg` pool, `withTransaction`), `connect.ts` (startup retry), `migrate.ts` + `migrations/` (TypeScript files exporting SQL), `health.ts` (db liveness flag).
- `docker/`: `Dockerfile` (multi-stage, Node 22, `npm ci`), `compose.yaml` (api + db) and `compose.local.yaml` (Docker Desktop override).

## Stack (api + db)

`compose.yaml` runs `api` and `db` (`postgres:17-alpine`, no published port). The api waits for the db healthcheck, then connects with the standard `PG*` env vars (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`; compose maps them from `POSTGRES_*`). Migrations run at startup before the listener opens; a failed migration or an unreachable db exits the process and compose restarts it.

- Full stack on Docker Desktop: `docker compose -f docker/compose.yaml -f docker/compose.local.yaml --env-file .env up -d --build`
- Db only for `npm run dev`: the same command with `db` at the end, and `PGHOST=localhost` in `.env`. The db is published on `127.0.0.1:${PG_PUBLISH_PORT:-5432}`.
- `POSTGRES_PASSWORD` lives only in the gitignored `.env` and in Dokploy env. Never commit it.
- `/api/health` returns `db: "up" | "down"`; it stays 200 when the db is down.

## Response envelope

Every response is `{ code, status, entry, exit, data, error }`: `data` is
always an array, `status` is `resolved` | `rejected`, `error` is `""` or a
stable snake_case code, never a stack.

## Configuration (environment only)

| Var | Notes |
|---|---|
| `API_PORT` | Listen port (container uses 3002). |
| `HA_URL` | Home Assistant base URL, e.g. `http://192.168.50.200:8123`. |
| `HA_TOKEN` | HA long-lived token. Never commit or expose to the frontend. |
| `API_TOKEN` | Required in prod. `/api/*` needs `Authorization: Bearer <API_TOKEN>` except `GET /api/health`. Empty disables the gate (local dev). |
| `CORS_ORIGINS` | Comma-separated allowlist, e.g. `https://home-control.hectorrdez.es,http://localhost:5173`. |
| `LOG_TO_FILE` | `true` also writes CSV logs under `data/`. |
| `ALIASES_FILE` | Legacy import source only: old JSON aliases file, imported once into Postgres when the aliases table is empty, then renamed `*.imported-<ms>`. Default `/data/aliases.json`. |
| `CALIBRATIONS_FILE` | Legacy import source only (same one-time import as `ALIASES_FILE`). Default `/data/calibrations.json`. |
| `ALERT_RULES_FILE` | Legacy import source only (same one-time import as `ALIASES_FILE`). Default `/data/alert-rules.json`. |

## Deploy (Dokploy, homelab)

**Primary method: Dokploy Compose stack, see "Deploy (Dokploy compose)" and its
cutover runbook below.** The single-application method described in this paragraph
is **legacy / rollback only**: Application from GitHub `hectorrdez/home-control-backend`, branch `dev`, build
type Dockerfile (`docker/Dockerfile`), container port 3002 published on a host
port (3041). Set the env vars above in Dokploy. The image has a healthcheck on
`/api/health`. Alternative: compose source with `docker/compose.yaml`
(`PUBLISH_PORT` sets the host port).

**Data:** aliases, calibrations and alert rules live in the Postgres `documents`
table (see the `db` service in `docker/compose.yaml`). The old JSON files
(`ALIASES_FILE`, `CALIBRATIONS_FILE`, `ALERT_RULES_FILE`, default `/data/*.json`)
are a legacy import source only: at startup each one is imported once into an
empty collection and renamed to `<file>.imported-<epochMs>`. A failed import is
logged and the file is kept. Back up the database, not the JSON files.

### Deploy (Dokploy compose)

Runbook for the user. Stack = `api` + `db` + `db-backup` from `docker/compose.yaml`.

1. In Dokploy project HomeControl create a **Compose** service `home-control-stack` (source Git, repo home-control-backend, branch `dev`, compose path `docker/compose.yaml`, type docker-compose).
2. Env (Dokploy env, never in git): `HA_URL`, `HA_TOKEN`, `API_TOKEN`, `CORS_ORIGINS`, `POSTGRES_PASSWORD` (new, long random), optional `POSTGRES_DB` / `POSTGRES_USER`, `PUBLISH_PORT=3041`, `DATA_VOLUME_NAME=home-control-aliases` (reuses the old volume so the one-time JSON import works), `EVENTS_RETENTION_DAYS=365`. Optional backup knobs: `BACKUP_KEEP` (default 7), `BACKUP_INTERVAL_SECONDS` (default 86400), `BACKUP_VOLUME_NAME` (default `home-control-pg-backups`).
3. Stop the old `home-control-backend` application (frees port 3041), deploy the compose service, then check that `api` and `db` are healthy: `docker ps --filter name=home-control-stack --format '{{.Names}}	{{.Status}}'` (Dokploy generates the container names from the compose app name; `db` and `db-backup` appear as `...-db-1` / `...-db-backup-1` or similar), `GET /api/health` returns `db: "up"`, and aliases/rules/calibrations are present (look for the import log line). Keep the old application **stopped, not deleted**, for one week as rollback. Rollback = stop the compose service, start the old app (the JSON files were renamed `*.imported-*`: rename them back first).
4. Caddy and dnsmasq unchanged.
5. Backups: `db-backup` writes `homecontrol-<timestamp>.dump` (custom format) into the `home-control-pg-backups` volume on start and every 24 h, keeping the newest 7. Restore into the running db (the backups volume is mounted read-only into `db` at `/backups`):
   ```
   DB=$(docker ps --filter name=home-control-stack --format '{{.Names}}' | grep -E -- '-db-[0-9]+$|_db[._]' | grep -v backup | head -1)
   docker exec "$DB" ls -1 /backups
   docker exec "$DB" pg_restore -U <user> -d <db> --clean --if-exists /backups/<file>.dump
   ```
   Adjust the `grep` if `docker ps` shows other names; any container whose name contains the compose app name and `db` (not `db-backup`) works. To test first, restore into a scratch DB: `docker exec "$DB" createdb -U <user> scratch && docker exec "$DB" pg_restore -U <user> -d scratch /backups/<file>.dump`.

Local Docker Desktop: same compose file plus `docker/compose.local.yaml`, with `POSTGRES_PASSWORD` in `.env`:
`docker compose -f docker/compose.yaml -f docker/compose.local.yaml --env-file .env up -d --build`.
`docker compose ... down` keeps data; `down -v` **wipes the database and the backups** (warn before using it).

### Caddy

`/home/hector/docker/caddy/Caddyfile` (Tailscale only via `import privado`; the
frontend will later serve `/` on the same host):

```caddy
home-control.hectorrdez.es {
	import privado
	handle /api/* {
		reverse_proxy 192.168.50.200:3041
	}
	handle {
		# frontend goes here later
		respond "home-control frontend not deployed" 404
	}
}
```

DNS: `address=/home-control.hectorrdez.es/100.89.193.64` in
`/home/hector/docker/dnsmasq-ts/dnsmasq.conf`, then restart dnsmasq-ts.
