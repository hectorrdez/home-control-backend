---
id: "009"
slug: entity-device-names
title: Expose the HA device name on normalized entities
role: backend
type: change
extends: "002"
---

# Expose the HA device name on normalized entities

## Description
Home Assistant friendly names usually start with the name of the device the entity belongs to ("RT-AC65P Velocidad de descarga", "samsung s24 hector Battery level"). The panel (frontend 115) wants to strip exactly that prefix, but guessing it from sibling entity names is unreliable ("RT-AC65P Velocidad de" would be taken as the prefix, "Bedroom lamp"/"Bedroom blinds" would lose "Bedroom"). This feature adds the real HA device name to every normalized entity so the client can strip it exactly. Extends 002 (entity shape); also changes the entity shape returned by 004 (areas), 003 (action response) and 005 (stream), because they all share `normalizeEntity`.

## Requirements
- Extends feature 002 (normalized entity) and touches 004 (areas reuse the same shape). Reuse `src/modules/ha/HaStates.ts`: same pattern as `fetchAreaIndex` (template call + short in-memory cache).
- New field on `NormalizedEntity`: `deviceName: string | null` = the HA device registry name of the entity's device: `name_by_user` if set, else `name`; `null` when the entity has no device, the device has no name, or resolution failed. Trimmed; empty string -> `null`. No other change to the shape (no alias, no area change).
- Resolution: ONE batched HA call per cache window, `POST /api/template` (via `haPostText`) with:
  `{% for s in states %}{{ s.entity_id }}|{{ device_attr(s.entity_id, 'name_by_user') or device_attr(s.entity_id, 'name') or '' }}\n{% endfor %}`
  Parse line by line, split on the FIRST `|` only (a device name may contain `|`); ignore lines without an entity id. Never one call per entity.
- New `fetchDeviceNameIndex()` returning a Map entityId -> device name, cached ~60s (`DEVICE_CACHE_MS = 60_000`), separate from the 30s area cache. Concurrent callers during a refresh share the same in-flight promise (no thundering herd).
- Failure degrades, never fails the request: HA template error, timeout or unparsable reply -> log a warning (no token, no body dump), return an empty map (every `deviceName` = `null`). Do NOT cache the failure for the full window (retry on the next request, or cache the empty result for at most ~10s). `GET /api/entities` and `GET /api/areas` keep their current errors only for the states call itself.
- `normalizeEntity(s, areas, deviceNames?)`: third optional param; missing map -> `deviceName: null`. Update every caller:
  - `EntitiesService` and `AreasService`: fetch the device index in parallel with states/areas (`Promise.all`, with the index call wrapped in a catch -> empty map).
  - `EntitiesControlService` (action response) and `stream/HaEvents.ts` (`state_changed` payload): use the same cached index with the same catch, so every normalized entity carries the field (one shape everywhere; the frontend replaces entities from the stream and must not lose `deviceName`).
- Sorting, filters, areas grouping unchanged. Do not expose any other device attribute (no device id, manufacturer, model).
- Contract + Bruno as ONE unit:
  - `.claude/endpoints.md`: add `deviceName` to the entity shape in the `GET /api/entities` row (note: "HA device name (`name_by_user` or `name`) or null; via `/api/template`, cached 60s, failure -> null"), and mention in the `GET /api/areas`, `POST /api/entities/:entityId/action` and `GET /api/stream` rows that the normalized entity includes `deviceName`.
  - Bruno `tests/bruno/entities/list.bru`: the `all.keys` assertion gets `deviceName`; new test: every item has `deviceName` that is `null` or a non-empty string; at least one entity has a non-null `deviceName` (the homelab HA has device-backed entities, e.g. the RT-AC65P router). `tests/bruno/areas/list.bru`: each entity has `deviceName` (`null` or non-empty string).
  - Degrade path (HA template failure -> null) is not reproducible against the live HA from Bruno; document it as covered by code review only, unless a unit runner exists (then add a unit test for the parser: first-`|` split, empty -> null, failure -> empty map).
- Refreshing the frontend's read-only `endpoints.md` copy is done by frontend feature 115, not here.

## Touches existing endpoints
yes - response shape only (new field `deviceName`), all additive:
- GET /api/entities (002) - `tests/bruno/entities/list.bru` key assertion must be updated (expected contract change, not a regression).
- GET /api/areas (004)
- POST /api/entities/:entityId/action (003) - response entity
- GET /api/stream (005) - `state_changed` payload

## Done when
- `GET /api/entities` and `GET /api/areas` return `deviceName` for every entity (real device names for device-backed entities, `null` otherwise), resolved with one template call per 60s window.
- A failing template call yields `deviceName: null` everywhere and the request still succeeds.
- Action responses and stream events carry the same field.
- endpoints.md rows updated; Bruno asserts the new field.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
