---
id: "024"
slug: ha-reload-integrations
title: Endpoint to reload the HA device integrations (Tuya, LocalTuya)
role: backend
type: feature
extends: null
---

# Endpoint to reload the HA device integrations

## Description
A device added later in the Smart Life app does not appear in Home Assistant until the Tuya integration reloads its config entry, so it never reaches the panel. This feature adds `POST /api/ha/reload`, which asks HA to reload the config entries of an allow-listed set of integrations, so the new devices show up without opening HA. The frontend settings page (164) calls it.

## Requirements
- `POST /api/ha/reload` (Bearer API_TOKEN, no body). The client sends nothing to choose entries: the server decides, so arbitrary integrations cannot be reloaded.
- Allow-list from env `HA_RELOAD_DOMAINS` (comma separated, trimmed, lowercase), default `tuya,localtuya`. Empty value -> 400 `reload_disabled`.
- Flow: list HA config entries (REST `GET /api/config/config_entries/entry`, through the existing HA client with its timeout/retry/ping hardening of 022); keep entries whose `domain` is in the allow-list and that are not disabled by the user (`disabled_by` null); reload each with `POST /api/config/config_entries/entry/{entry_id}/reload`. Entries are reloaded one after another (never in parallel) so Tuya cloud is not hit by bursts.
- Response `{ data: [{ entryId, domain, title, ok, error? }], entities: { before, after } }`: `before` = entity count in `HaCache` at call time, `after` = count after the reload settles (poll the cache up to about 8 s, 500 ms steps, stop early when the count is stable for 2 polls). One entry failing does not stop the others; `ok: false` plus a short `error` for that entry (no HA token or URL in messages).
- After reloading, force the HA cache to refresh its registries (reuse the 023 refresh path used by the `*_registry_updated` events; if there is none, request the 4 lists again) and emit the existing SSE `resource_changed` frame for entities and areas so open panels refetch (reuse the 013-020 event hub).
- Errors: HA unreachable or auth failure -> 502 with the same error shape and mapping as the other HA routes; no entries matched -> 200 with `data: []` and `entities` unchanged.
- Concurrency: at most one reload at a time (a second call while one runs -> 409 `reload_in_progress`) and a 30 s cooldown after finishing (-> 429 `reload_cooldown` with `retryAfterSeconds`). In-memory is enough.
- Logs: domain, entry id, result. Never log tokens.
- Unit tests (HA client mocked): allow-list filter, disabled entries skipped, sequential order, partial failure, 409, 429, 502, empty allow-list, before/after counts, SSE frame emitted. Update `.claude/endpoints.md`. Bruno requests in the backend testing repo are added separately (never call the real reload against PRO in tests: mock or skip).

## Touches existing endpoints
no (new route under /api/ha; GET /api/ha/status unchanged)

## Done when
- With a Tuya entry configured in HA, `POST /api/ha/reload` reloads it and a device newly added in Smart Life appears in `GET /api/entities` and `/api/areas` without restarting anything.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
