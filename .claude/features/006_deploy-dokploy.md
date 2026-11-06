---
id: "006"
slug: deploy-dokploy
title: Production deploy on Dokploy
role: backend
type: feature
extends: null
---

# Production deploy on Dokploy

## Description
Make the API deployable on the homelab Dokploy, without MySQL, configurable only by environment.

## Requirements
- Remove MySQL from the template: `mysql2`, db/ folder, DB env vars, db service in compose, unused Repository/Connection wiring that needs a DB.
- Production Dockerfile (multi-stage, Node 22, npm ci) and compose/Dokploy config; env: API_PORT, HA_URL, HA_TOKEN, CORS_ORIGINS, API_TOKEN (required in prod: frontend -> API gate).
- Document Caddy: `home-control.hectorrdez.es` with `import privado`, /api routed to this service.
- Health check wired to `/api/health`.

## Touches existing endpoints
yes: /api/health must keep working after removing the DB layer

## Done when
- Image builds and runs with only the env vars above; no MySQL needed.
- Deployed on Dokploy and reachable via Tailscale; `/api/health` and `/api/ha/status` respond.
- README updated.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
