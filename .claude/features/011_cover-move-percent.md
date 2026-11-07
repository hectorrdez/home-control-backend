---
id: "011"
slug: cover-move-percent
title: Move a calibrated cover to a percentage (timed stop)
role: backend
type: feature
extends: "010"
---

# Move a calibrated cover to a percentage (timed stop)

## Description
With calibration (010) a cover with no position feedback can be driven to a target percentage: the backend sends open/close, waits the proportional travel time and sends `stop_cover`. Doing it server-side means closing the browser tab never leaves the cover half way.

## Requirements
- `POST /api/entities/:entityId/cover-percent` body `{ "percent": 0..100 }` -> `{ data: [normalized entity with attributes.estimated_position] }`. 100 = fully open.
- Requires a calibration (010) else `not_calibrated` 409. Domain must be `cover`; entity must exist (`entity_not_found` 404); `percent` integer 0..100 -> `invalid_params` 400.
- Algorithm: current = stored `position`. delta = target - current; delta > 0 -> `open_cover`, delta < 0 -> `close_cover`; duration = |delta|/100 * openMs (or closeMs).
  - Targets 0 and 100: drive the full leg (works even when the position is unknown); no `stop_cover` is sent (the motor limit stops it); position becomes 0 or 100 when the full-leg time (+10% margin) elapses.
  - Intermediate target with unknown position -> `position_unknown` 409 (client must move to an end first).
  - Intermediate target with known position: send `stop_cover` after `duration` using an in-memory timer.
- One in-flight move per entity: a new request cancels the previous timer, sends `stop_cover`, estimates the position reached from elapsed time and plans from there. `POST .../action` with `stop_cover`/`open_cover`/`close_cover` also cancels any timer and updates the estimate (stop -> estimate from elapsed time; open/close -> position becomes unknown until the leg time passes).
- Persist `position` in the calibration store after each move ends or is cancelled. Expose it as `estimated_position` (0..100 or null) in the cover's normalized attributes (`/api/entities`, `/api/areas`, stream, responses).
- Timers are lost on restart: on startup, covers with an unfinished move get `position: null`.
- Route + `endpoints.md` + Bruno + vitest (fake timers for the timing logic, HA client mocked) as ONE unit.

## Touches existing endpoints
yes: `/api/entities`, `/api/areas`, `/api/stream` cover entities gain `attributes.estimated_position` (additive); `POST /api/entities/:id/action` cancels pending timed moves.

## Done when
- Unit tests prove timing, cancel, unknown-position and not_calibrated paths; Bruno covers 409/400/404; test.cjs green.
