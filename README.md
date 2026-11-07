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
| `ALIASES_FILE` | JSON file for user entity aliases. Default `/data/aliases.json` (container); local dev `./data/aliases.json`. Must be writable. |
| `CALIBRATIONS_FILE` | JSON file for cover open/close calibrations. Default `/data/calibrations.json` (container); local dev `./data/calibrations.json`. Same `/data` volume as aliases. |
| `ALERT_RULES_FILE` | JSON file for alert rules. Default `/data/alert-rules.json` (container); local dev `./data/alert-rules.json`. Same `/data` volume as aliases. |

## Deploy (Dokploy, homelab)

Application from GitHub `hectorrdez/home-control-backend`, branch `dev`, build
type Dockerfile (`docker/Dockerfile`), container port 3002 published on a host
port (3041). Set the env vars above in Dokploy. The image has a healthcheck on
`/api/health`. Alternative: compose source with `docker/compose.yaml`
(`PUBLISH_PORT` sets the host port).

**Data volume:** the API stores user entity aliases (`ALIASES_FILE`, default
`/data/aliases.json`) and cover calibrations (`CALIBRATIONS_FILE`, default
`/data/calibrations.json`) and alert rules (`ALERT_RULES_FILE`, default
`/data/alert-rules.json`) as small JSON files in `/data`. In Dokploy (Dockerfile build
type) add a volume mount for `/data`, e.g. named volume `home-control-aliases`,
or aliases, calibrations and alert rules are lost on redeploy. Backup = copy those files. The compose file
already declares the `aliases-data` volume (it covers all three files).

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
