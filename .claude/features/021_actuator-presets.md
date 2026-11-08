---
id: "021"
slug: actuator-presets
title: Saved positions (presets) per actuator + apply endpoint
role: backend
type: feature
extends: "011"
---

# Saved positions (presets) per actuator + apply endpoint

## Description
The user wants to save named positions for an actuator (e.g. "Persiana Salon Cortina": "Media" = 50 %, "Lectura" = 30 %) and later run them with one tap from the panel (frontend 142 device detail, 143 Home 3D "MODES" button). This feature stores those presets in Postgres (014 `PgDocumentStore`), shared by every device, announces changes on the 016 bus and offers one endpoint that drives the actuator to the stored percentage, reusing the 011 timed move for calibrated covers. Depends on 014 (ENDED) and 016 (`resource_changed`).

## Decisions (refined 2026-11-08, Opus)
- v1 scope = domain `cover` only (the user's example). A cover can apply a preset when it is calibrated (010/011, timed move) OR reports a native `current_position` (HA `set_cover_position`). The shape uses a generic `percent` so lights (`brightness_pct`) / fans (`percentage`) can be added later by widening the domain allowlist, with no data migration.
- Presets are global (one household), like aliases and settings.

## Requirements
- Module `presets` (generator if it exists, else by hand like `alert-rules`): routes, controller, service, `PresetErrors.ts`, `PresetValidation.ts`, `PresetStore.ts` = `PgDocumentStore` collection `presets`, key = preset uuid (server-generated, `crypto.randomUUID()`), value `{ entityId, name, percent, createdAt }`. Max 500 presets in total, max 10 per entity.
- Validation: `entityId` regex `^[a-z_]+\.[a-z0-9_]+$` (`invalid_entity_id` 400), domain must be `cover` (`domain_not_allowed` 403, reuse existing errors); `name` string, trimmed, 1..30 chars, no control chars (`invalid_preset` 400); `percent` integer 0..100 (`invalid_preset` 400). Same `name` (case-insensitive, trimmed) twice for one entity -> `duplicate_preset` 409. 11th preset for an entity or 501st overall -> `too_many_presets` 400. Write failure -> `presets_write_failed` 500, memory unchanged (store pattern from 014).
- Endpoints (Bearer API_TOKEN, CRUD works while HA is down: no HA call):
  - `GET /api/presets` (optional `?entityId=`) -> `{ data: [{ id, entityId, name, percent, createdAt }] }` sorted by entityId, then percent, then name.
  - `POST /api/presets` body `{ entityId, name, percent }` -> `{ data: [preset] }` (201 or 200, follow the alert-rules convention).
  - `PUT /api/presets/:id` body `{ name, percent }` (entityId immutable; if sent and different -> `invalid_preset` 400) -> `{ data: [preset] }`; unknown id -> `preset_not_found` 404.
  - `DELETE /api/presets/:id` -> `{ data: [] }`, idempotent.
  - `POST /api/presets/:id/apply` -> `{ data: [normalized entity] }`:
    - unknown id -> `preset_not_found` 404; entity gone from HA -> `entity_not_found` 404.
    - cover with a calibration (010) -> same path as `POST /api/entities/:id/cover-percent` (`CoverPercentService.setCoverPercent` / `coverMoves.moveTo`), so `position_unknown` 409 (intermediate target, unknown position) and the one-move-per-entity cancel rule of 011 apply unchanged.
    - else cover whose HA state has numeric `current_position` -> HA `cover.set_cover_position` with `position: percent` through `controlEntity` (keeps the cover move cancel hook).
    - else -> `preset_not_applicable` 409 ("cover needs calibration or position feedback").
- Client identity (016): `mutate(..., { by: res.locals.clientId })`; store `onChanged` emits `resource_changed { resource: "presets", keys, by }` -> extend the `AppEvents` union with `"presets"`.
- If 018 (event log) is ENDED when this is built: `apply` records an `action` event (`payload { action: "preset", params: { presetId, percent }, ok, error? }`) the same way cover-percent does; if not, skip (018 adds it).
- Orphan presets (entity missing in HA) are kept (entity may be offline), like alert rules.
- Route + `.claude/endpoints.md` + Bruno + vitest as ONE unit. `add-note.cjs`: presets collection, cover-only v1, apply reuses 011.

## Touches existing endpoints
no (new routes). `GET /api/stream` carries `resource_changed` with `resource: "presets"` (016 frame, new resource value).

## Done when
**Unit (vitest)**
- Validation: every bad id/domain/name/percent case; duplicate name case-insensitive; per-entity cap 10 and global cap 500; PUT cannot change entityId.
- Apply: calibrated cover -> `moveTo(entityId, percent)` called; native-position cover -> `set_cover_position` with the percent; neither -> 409 `preset_not_applicable`; unknown preset 404; HA client mocked.
- Store emits `resource_changed` `presets` once per successful mutate, with `by`.

**Bruno** (`tests/bruno/presets/`, dedicated id `cover.bruno_calibration_test`, cleanup at the end)
- POST -> 200/201 with id; GET `?entityId=` lists it; duplicate name -> 409; percent 101 -> 400; `light.x` -> 403; PUT rename -> 200; PUT unknown -> 404; apply on the test cover without calibration nor position -> 409 `preset_not_applicable` (or 404 if the entity does not exist in HA: assert one of the two documented codes); DELETE -> 200; DELETE again -> 200; no token -> 401.

**E2E / manual (orchestrator)**
- On the real `cover.persiana_salon_cortina` (calibrated): create preset 50 %, move to 0 % first, apply -> cover stops at about half; `curl -N` stream shows `resource_changed presets` on create. test.cjs green.
