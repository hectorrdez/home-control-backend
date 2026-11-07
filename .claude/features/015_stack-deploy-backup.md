---
id: "015"
slug: stack-deploy-backup
title: Dokploy compose stack cutover + nightly Postgres backup
role: backend
type: change
extends: "006"
---

# Dokploy compose stack cutover + nightly Postgres backup

## Description
Ships the 013/014 stack to the homelab. Today Dokploy runs the backend as a single "application" (swarm service, host port 3041, volume `home-control-aliases` on `/data`). It becomes a Dokploy **Compose** service built from `docker/compose.yaml` (`api` + `db` + `db-backup`), same host port 3041, so Caddy (`/api/*` -> 3041) does not change. Adds a tiny nightly `pg_dump` backup. Depends on 013 and 014. Do NOT push backend `dev` with 013/014 before this feature is ready: the old Dokploy application has no db and the new API refuses to start without one.

## Requirements
- `docker/compose.yaml`: add service `db-backup` using the SAME `postgres:17-alpine` image (no extra image pull), `restart: unless-stopped`, env `PGHOST=db` + the PG* vars, `BACKUP_KEEP` (default 7), volume `pg-backups:/backups` (`name: ${BACKUP_VOLUME_NAME:-home-control-pg-backups}`), `depends_on: db (service_healthy)`, entrypoint a short `sh -c` loop: on start and then every 24 h run `pg_dump -Fc -f /backups/homecontrol-$(date +%Y%m%d-%H%M%S).dump`, then delete all but the newest `BACKUP_KEEP` files; log one line per run (no secrets). No healthcheck needed.
- Resource limits (work with both plain compose and Dokploy): `api` `mem_limit: 256m`, `db` `mem_limit: 256m`, `db-backup` `mem_limit: 64m`.
- `api` keeps the Dockerfile HEALTHCHECK (`/api/health`, liveness only, see 013).
- README "Deploy (Dokploy compose)" runbook, written for the user, step by step:
  1. In Dokploy project HomeControl create a **Compose** service `home-control-stack` (source Git, repo home-control-backend, branch `dev`, compose path `docker/compose.yaml`, type docker-compose).
  2. Env (Dokploy env, never in git): `HA_URL`, `HA_TOKEN`, `API_TOKEN`, `CORS_ORIGINS`, `POSTGRES_PASSWORD` (new, long random), optional `POSTGRES_DB`/`POSTGRES_USER`, `PUBLISH_PORT=3041`, `DATA_VOLUME_NAME=home-control-aliases` (reuses the old volume so 014 imports the JSON files), `EVENTS_RETENTION_DAYS=365`.
  3. Stop the old `home-control-backend` application (frees port 3041), deploy the compose service, check `docker compose ps` healthy and `GET /api/health` -> `db: "up"`, check aliases/rules/calibrations are present (import log line). Keep the old application stopped (not deleted) for one week as rollback; rollback = stop compose, start old app (the JSON files were renamed `.imported-*`: rename back before rollback).
  4. Caddy and dnsmasq unchanged.
  5. Restore: `docker compose exec db pg_restore -U <user> -d <db> --clean /backups/<file>` (backups volume mounted read-only into `db` too: add `pg-backups:/backups:ro` to `db`).
- Local Docker Desktop section: same compose + `compose.local.yaml`, `.env` with `POSTGRES_PASSWORD`; `docker compose ... down` keeps data, `down -v` wipes it (warn).
- Update the 006 note via `add-note.cjs`: Dokploy now runs the compose stack `home-control-stack`; `DATA_VOLUME_NAME=home-control-aliases`; old application kept stopped as rollback; backups in volume `home-control-pg-backups`.

## Touches existing endpoints
no

## Done when
**Unit**
- none new (compose/ops only); existing vitest green.

**Bruno**
- Whole collection green against the local full stack (`compose.yaml` + `compose.local.yaml`).

**E2E / manual (orchestrator, Docker Desktop, then homelab with user confirmation)**
- Local: `docker compose -f docker/compose.yaml -f docker/compose.local.yaml config` valid; `up -d --build` -> `api` and `db` healthy, `db-backup` writes one `.dump` within a minute of start; restart `db-backup` 8 times with `BACKUP_KEEP=7` -> 7 files remain.
- Restore runbook executed once locally into a scratch db.
- Homelab cutover only after the user says yes; afterwards https://home-control.hectorrdez.es/api/health -> `db: "up"` and the panel shows the old aliases. test.cjs green.
