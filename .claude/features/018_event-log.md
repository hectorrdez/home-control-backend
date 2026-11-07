---
id: "018"
slug: event-log
title: Persistent event log (interactions, config changes) + query API
role: backend
type: feature
extends: null
---

# Persistent event log (interactions, config changes) + query API

## Description
Append-only history of what happened through the panel, stored in the `events` table (013) and queryable later: device actions sent by any client, alias/calibration/alert-rule/setting changes, and (019/020) HA link, availability and alert events. Sensor/state time series are NOT copied: they stay in Home Assistant's recorder (read via 007). New events are also pushed live on the SSE stream as `event`. Depends on 017.

## Requirements
- `src/modules/events/EventLog.ts` `eventLog.record({ type, source, entityId?, level?, payload?, clientId?, clientName? })`: inserts into `events`, then emits app event `{ type: "event", event: <stored row as API shape> }` on `appEvents` (016). Fire-and-forget: never throws to the caller, never delays the HTTP response (do not await in request handlers), db failure -> `Logger.error` once per minute max (rate-limited), event dropped. Payload capped at 4 KB serialized (bigger -> `{ truncated: true }`).
- API shape of an event: `{ id: string (bigint as string), ts: ISO, type, source, entityId: string|null, level: string|null, clientId: string|null, clientName: string|null, payload: object }`.
- Event types recorded by this feature (`source` in brackets):
  - `action` [`api`]: every `POST /api/entities/:entityId/action` and `POST /api/entities/:entityId/cover-percent` AFTER it resolves: payload `{ action, params?, ok: boolean, error?: <ApiError code> }` (for cover-percent `action: "cover_percent"`, `params: { percent }`), entityId, client id/name from 016. Validation failures before the entity is known (bad id) are NOT logged.
  - `config_changed` [`api`]: from the 016 bus for every `resource_changed`: payload `{ resource, keys }`, clientId = `by`. Values are NOT copied into the log (settings can be 64 KB).
- Retention: `EVENTS_RETENTION_DAYS` (int 1..3650, default 365). Hourly job `DELETE FROM events WHERE ts < now() - interval '<n> days'` (parameterized), first run 1 min after start; also deletes acked `alerts` older than the window. Log count deleted at INFO when > 0.
- `GET /api/events` query: `types` (comma list of `^[a-z_]+$`, max 10), `entityId` (entity regex), `from` / `to` (ISO 8601, `from <= to`), `before` (event id cursor, digits only: returns events with id < before), `limit` (1..500, default 100). Response `{ data: [event] }` newest first (`ORDER BY id DESC`). Errors: `invalid_query` 400 (any bad param, message names it). All SQL parameterized.
- No `POST /api/events` (clients do not write the log directly; their interactions are recorded where they hit the API).
- `endpoints.md` row + SSE `event` documented on the stream row.

## Touches existing endpoints
yes: `POST /api/entities/:entityId/action` and `POST /api/entities/:entityId/cover-percent` now also log (response unchanged); `GET /api/stream` carries `event`.

## Done when
**Unit (vitest)**
- `eventLog.record` inserts with the right params, emits after insert, swallows db errors (no throw, rate-limited log), truncates big payloads.
- Query parser: every param valid/invalid case, cursor, limit bounds, from > to rejected.
- Action controller records ok + error outcomes (mock eventLog), not for invalid ids; response body unchanged.
- Retention SQL built with the configured days; invalid env falls back to 365.

**Bruno** (`tests/bruno/events/`)
- Run an action on the dedicated test entity (same one the entities suite uses) -> `GET /api/events?types=action&entityId=<it>&limit=1` -> newest event has `payload.ok === true` and the action name.
- PUT + DELETE a test alias -> `GET /api/events?types=config_changed&limit=5` contains `resource: "aliases"`.
- Paging: `limit=2` then `before=<last id>` returns older ids only.
- `limit=0`, `limit=501`, `types=Bad-Type`, `from=nope`, `before=abc`, `from` after `to` -> 400 `invalid_query`. No token -> 401.

**E2E / manual**
- SSE client sees `event: event` right after an action. test.cjs green.
