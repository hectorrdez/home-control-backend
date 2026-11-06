# Project brief

## Goal
home-control-backend is a thin API between the home-control clients (web panel and Electron shell, repo home-control-frontend) and Home Assistant running on the homelab. It exposes entities and areas, controls devices and streams state changes in real time, so the Home Assistant long-lived token never reaches a client. Everything runs on the homelab (Dokploy) and is reached privately over Tailscale.

## Stack
TypeScript + Node 22 + Express 4 (create-project API template). MySQL exists in the template but is unused. Acceptance tests with Bruno (`tests/bruno`). Home Assistant over REST + WebSocket.

## Repo type
backend

## Scope - in
- Home Assistant client (REST + WebSocket) configured by `HA_URL` and `HA_TOKEN`.
- List entities (filter by domain/area), control them, list areas with their entities.
- Real-time stream of `state_changed` events (SSE) with reconnection.
- Production deploy on Dokploy (homelab), without MySQL.

## Scope - out (explicitly NOT doing)
- User accounts or auth: access is restricted by Tailscale/Caddy (`import privado`).
- Own database or persistence (MySQL is removed in feature 006).
- Alexa integration (decide later, separate effort).
- Own automations or device logic that Home Assistant already provides.
- Any UI (lives in home-control-frontend).

## Conventions / decisions
- `HA_TOKEN` is the Home Assistant long-lived token; it is NOT `API_TOKEN`. `API_TOKEN` (frontend -> this API, `Authorization: Bearer`, gate in `src/shared/guards/apiKey.ts`) is required in prod; empty only in local dev. Never log or return it.
- Device control only through an allowlist of HA domains (`light`, `switch`, `climate`, `cover`, `fan`, `media_player`, `scene`, `script`).
- Responses use the template envelope `{ code, status, entry, exit, data, error }` (`data` always an array).
- New domains via `npm run new:module <name>`; handlers use `route()` from `@shared/http/route` and typed `ApiError`s.
- Every endpoint change updates the route, `.claude/endpoints.md` and the Bruno request as one change.
- HA runs on the homelab LAN: `HA_URL=http://192.168.50.200:8123` (never localhost inside a container).
- Kanban: Plane (workspace scouttech, project HomeControl). General cards carry label `Main`; per-repo subtasks carry `repo:<repo>`.
