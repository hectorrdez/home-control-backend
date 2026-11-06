---
id: "008"
slug: entity-aliases
title: User-editable entity aliases (file store)
role: backend
type: feature
extends: null
---

# User-editable entity aliases (file store)

## Description
Home Assistant friendly names are long, carry the device-name prefix, double spaces and a Spanish/English mix (e.g. "ENCERRADO EN EL PATIO  Batería", "RT-AC65P Velocidad de descarga") while the panel UI is English. The panel (frontend 115) cleans names automatically and lets the user rename any entity; this feature stores those aliases in the backend so they are shared by every client (browser, Electron, phone). Persistence is a single small JSON file on a Docker volume, not a database.

## Requirements
- New module `aliases` via `npm run new:module aliases` (`src/modules/aliases/`: routes, controller, service, `AliasErrors.ts`, file store). Handlers use `route()` + typed `ApiError` subclasses; same envelope (`data` always an array). Behind the existing `API_TOKEN` gate like every `/api/*` route.
- Endpoints (contract):
  - `GET /api/aliases` -> `{ data: [{ entityId, alias }] }`, sorted by `entityId`. Empty store -> `data: []`.
  - `PUT /api/aliases/:entityId` body `{ "alias": string }` -> `{ data: [{ entityId, alias }] }` (stored, normalized value). Creates or replaces.
  - `DELETE /api/aliases/:entityId` -> `{ data: [] }`, idempotent (200 also when no alias existed).
- Entities stay untouched: `GET /api/entities`, `/api/areas`, `/api/stream` do NOT get an `alias` field. The client merges aliases (keeps the HA contract and the stream unchanged, no cache invalidation).
- Validation:
  - `entityId` must match `^[a-z_]+\.[a-z0-9_]+$` (same regex as 007) -> else `invalid_entity_id` 400. The entity does not have to exist in HA (no HA call; aliases work while HA is down).
  - `alias`: must be a string; normalize = trim + collapse internal whitespace runs to one space; reject control characters; length after normalize 1..80 -> else `invalid_alias` 400 (missing/non-string/empty/too long). Resetting is DELETE, not an empty PUT.
  - Max 2000 stored aliases: a PUT that would create alias number 2001 -> `too_many_aliases` 400 (replacing an existing one is always allowed).
- File store:
  - Path from env `ALIASES_FILE`, default `/data/aliases.json`. Format `{ "version": 1, "aliases": { "<entityId>": "<alias>" } }`.
  - Loaded once at startup into an in-memory `Map`; reads are served from memory. Missing file -> empty store (file created on first write; create the parent dir with `mkdir -p` semantics).
  - Corrupt/unreadable file or wrong version -> log a warning (no contents), rename it to `aliases.json.corrupt-<timestamp>` and start empty; never crash the API.
  - Writes are atomic: write `<file>.tmp` then `rename` over the target. Writes are serialized (single promise chain/mutex) so concurrent PUT/DELETE cannot interleave. The in-memory map is updated only after the rename succeeds; write failure -> `aliases_write_failed` 500 and memory unchanged.
  - Ignore entries in the file that fail validation on load (log a count, not the values).
- Docker / deploy:
  - `docker/Dockerfile`: `RUN mkdir -p /data && chown node:node /data` before `USER node`, so a named volume inherits node ownership.
  - `docker/compose.yaml`: env `ALIASES_FILE: ${ALIASES_FILE:-/data/aliases.json}` and a named volume `aliases-data:/data` (declared under top-level `volumes:`).
  - README: add `ALIASES_FILE` to the configuration table; Deploy section: in Dokploy (Dockerfile build type) add a volume mount for `/data` (named volume, e.g. `home-control-aliases`) or the aliases are lost on redeploy; backup = copy that one file.
  - `.env.example`: `ALIASES_FILE=./data/aliases.json` for local dev (`data/` already gitignored and dockerignored).
- `project.md` scope says "no own database or persistence": record the exception with `node .claude/scripts/add-note.cjs` (tiny JSON file store ONLY for user aliases; no DB, no other persisted state; anything more needs a new decision).
- Route + `.claude/endpoints.md` (3 rows) + Bruno requests as ONE unit. Refreshing the frontend's read-only copy (`../home-control-frontend/.claude/endpoints.md`) is done by frontend feature 115, not here.
- Bruno (`tests/bruno/aliases/`, sequenced, uses a dedicated id `sensor.bruno_alias_test`, cleans up at the end): PUT creates and returns the normalized alias ("  Patio   battery " -> "Patio battery"); GET contains it; PUT replaces it; DELETE removes it; GET no longer contains it; DELETE again is 200; `invalid_entity_id` (e.g. `Light.Bad`); `invalid_alias` for empty string, missing body field and 81 chars. `too_many_aliases` is covered by a service-level check only if a unit runner exists; otherwise document it as not covered by Bruno (would need 2000 writes).
- Tests run against a local API with `ALIASES_FILE` from `.env` (local path); never point tests at the production volume.

## Touches existing endpoints
no (new `/api/aliases*` only; entities/areas/stream unchanged)

## Done when
- PUT/GET/DELETE behave as above and survive an API restart (file reloaded); the file is written atomically.
- Each validation error returns the typed envelope; the API starts with a missing or corrupt file.
- compose/Dockerfile/README/.env.example updated; note recorded in notes.md; endpoints.md has the 3 rows; Bruno covers happy path + errors.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
