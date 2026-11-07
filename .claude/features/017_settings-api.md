---
id: "017"
slug: settings-api
title: Shared settings API (dashboard layout, panels, filters)
role: backend
type: feature
extends: null
---

# Shared settings API (dashboard layout, panels, filters)

## Description
Generic key/value settings stored in Postgres and shared by every client, so a layout, panel or filter change on one device shows on all others. The server does not know the shape of each value (the frontend owns and validates its schemas); it only validates the key, size and JSON. Changes are announced as `resource_changed` (016). Depends on 016.

## Decisions (refined 2026-11-07)
- Scope: ALL settings are global (one household, no user accounts). Per-device overrides are out of scope; if ever needed they use a key prefix `device.<clientId>.` with no schema change.
- Concurrency: optimistic, opt-in. `PUT` may send `baseVersion`; mismatch -> 409 with the current setting so the client can apply server-wins. Without `baseVersion` -> last write wins.

## Requirements
- Module `settings` (`npm run new:module settings` if the generator exists, else by hand like `aliases`): `SettingStore` = `PgDocumentStore` collection `settings`, max 200 keys, entry `{ value: unknown, version: number, updatedAt: string, updatedBy: string | null }` (version/updatedAt/updatedBy are kept in the document value AND mirrored in the row columns; memory is the source for responses).
- Key rule: `^[a-z0-9]+(\.[a-z0-9_-]+){1,4}$`, max 80 chars (e.g. `telemetry.widgets`, `telemetry.panels`, `telemetry.filters`). Bad -> `invalid_setting_key` 400.
- Value rule: any JSON value except `undefined`; serialized size <= 65536 bytes -> else `setting_too_large` 413; missing `value` property -> `invalid_setting` 400.
- Endpoints (all Bearer API_TOKEN, no HA call, work while HA is down):
  - `GET /api/settings` -> `{ data: [{ key, value, version, updatedAt, updatedBy }] }` sorted by key; `[]` when empty.
  - `GET /api/settings/:key` -> `{ data: [setting] }`; unknown -> `setting_not_found` 404.
  - `PUT /api/settings/:key` body `{ value, baseVersion?: int >= 1 }` -> `{ data: [setting] }`. New key -> version 1; existing -> version + 1, `updatedAt` now, `updatedBy` = `res.locals.clientId`. Same `value` (deep equal via JSON string) -> no write, no version bump, returns current. `baseVersion` present and != current version (or key missing and baseVersion given) -> `version_conflict` 409 with `data: [current setting]` when it exists. Would create key #201 -> `too_many_settings` 400. Write failure -> `settings_write_failed` 500 (memory unchanged).
  - `DELETE /api/settings/:key` -> `{ data: [] }`, idempotent.
- After each successful write/delete emit `resource_changed { resource: "settings", keys: [key], by }` (via `onChanged`).
- Route + `endpoints.md` + Bruno + vitest as one unit.

## Touches existing endpoints
no (new routes; `GET /api/stream` carries `resource: "settings"`, already documented in 016)

## Done when
**Unit (vitest)**
- Validation: key regex/length, size limit (exactly 65536 ok, 65537 -> 413), missing value.
- Service: create v1, update v2, same value no bump, baseVersion match ok, mismatch -> conflict carrying current, cap 200, delete idempotent, `updatedBy` from client id, emit only on real change.

**Bruno** (`tests/bruno/settings/`, unique test key `test.bruno-<n>`, cleanup DELETE at the end)
- PUT new -> 200 v1; GET one -> same; GET list contains it; PUT same value -> still v1; PUT new value with `baseVersion: 1` -> v2; PUT with `baseVersion: 1` again -> 409 `version_conflict` and `data[0].version === 2`; bad key `Bad Key` -> 400; body without value -> 400; 70 KB value -> 413; GET unknown -> 404; DELETE -> 200; DELETE again -> 200; no token -> 401.

**E2E / manual**
- Two SSE clients receive `resource_changed` `settings` on PUT. test.cjs green.
