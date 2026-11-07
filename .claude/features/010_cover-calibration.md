---
id: "010"
slug: cover-calibration
title: Cover calibration store (open/close travel times)
role: backend
type: feature
extends: "008"
---

# Cover calibration store (open/close travel times)

## Description
Motorised covers without position feedback (e.g. `cover.persiana_salon_cortina`: state `unknown`, no `current_position`, features open/close/stop) cannot be moved to a percentage. The user calibrates them from the panel (frontend 127): they time one full open and one full close. This feature stores those two durations per cover, shared by all clients, in the same file-store style as aliases (008). It is a persistence exception to record in notes (same tiny-JSON-file rule as 008).

## Requirements
- New module `calibrations` (`npm run new:module calibrations`): routes, controller, service, `CalibrationErrors.ts`, file store. Reuse the atomic/serialized write, corrupt-file recovery and startup-load behaviour of `AliasStore` (extract a small generic JSON file store helper only if it stays simple; do not break 008). Same envelope (`data` array) and `API_TOKEN` gate.
- Env `CALIBRATIONS_FILE`, default `/data/calibrations.json`, format `{ "version": 1, "covers": { "<entityId>": { "openMs": n, "closeMs": n, "position": n|null, "calibratedAt": iso } } }`. Same Docker/README/.env.example treatment as 008 (the `/data` volume already exists).
- Endpoints:
  - `GET /api/calibrations` -> `{ data: [{ entityId, openMs, closeMs, position, calibratedAt }] }` sorted by `entityId`.
  - `PUT /api/calibrations/:entityId` body `{ openMs, closeMs }` -> stored entry (position reset to `null` = unknown). Creates or replaces.
  - `DELETE /api/calibrations/:entityId` -> `{ data: [] }`, idempotent.
- Validation: `entityId` regex `^[a-z_]+\.[a-z0-9_]+$` and domain must be `cover` -> `invalid_entity_id` 400 / `domain_not_allowed` 403 (reuse existing errors); `openMs`/`closeMs` integers 500..300000 -> `invalid_calibration` 400. Max 200 entries (`too_many_calibrations` 400; replacing allowed). Write failure -> `calibrations_write_failed` 500, memory unchanged.
- No HA call (works while HA is down). Entities/areas/stream do not carry calibration; the client merges.
- Route + `.claude/endpoints.md` + Bruno requests (`tests/bruno/calibrations/`, dedicated id `cover.bruno_calibration_test`, cleans up) as ONE unit; plus vitest unit tests for store and validation. Record the persistence exception with `add-note.cjs`.

## Touches existing endpoints
no

## Done when
- Bruno + unit tests cover create/replace/list/delete/validation; test.cjs green.
