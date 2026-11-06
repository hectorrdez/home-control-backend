---
id: "001"
slug: ha-client
title: Home Assistant client and status endpoint
role: backend
type: feature
extends: null
---

# Home Assistant client and status endpoint

## Description
Module that talks to Home Assistant over HTTP using HA_URL and HA_TOKEN, so every later feature reuses one client. Adds a status endpoint to check the link to HA.

## Requirements
- New module `ha` (`npm run new:module ha`) with a client (`fetch`, Authorization: Bearer HA_TOKEN, timeout, no token in logs or responses).
- Typed errors: HA unreachable, HA 401 (bad token), HA unexpected response -> ApiError subclasses with stable errorCode.
- `GET /api/ha/status` calls HA `GET /api/` and returns `{ online, message, version }` (version from `GET /api/config`).
- Fail fast at startup log (warn, not crash) if HA_URL or HA_TOKEN is missing.
- Create the Bruno collection skeleton in `tests/bruno` (env `local`) and the first request.

## Touches existing endpoints
no

## Done when
- `GET /api/ha/status` returns 200 with `data[0].online === true` against the real HA.
- Wrong token returns the typed error envelope, never the token itself.
- Endpoint documented in endpoints.md and covered by Bruno.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
