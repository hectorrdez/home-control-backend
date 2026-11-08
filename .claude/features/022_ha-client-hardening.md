---
id: "022"
slug: ha-client-hardening
title: HA client hardening (single-state reads, one request helper, timeouts, retry, WS heartbeat)
role: backend
type: change
extends: "001"
---

# HA client hardening (single-state reads, one request helper, timeouts, retry, WS heartbeat)

## Description
Board card "Mejora de interaccion con la api de HA" was vague; this is the concrete scope after reading `src/modules/ha` and `src/modules/stream`. Today every action downloads ALL HA states twice (`fetchState` = `GET /api/states` + find, before and after the service call), the HA service reply (the list of changed states) is ignored, `haGet`/`haPostText` duplicate the same request code, the 5 s timeout is hard-coded, a transient network blip fails the request immediately, and the HA WebSocket has no heartbeat (a half-open TCP connection after a Wi-Fi/router drop is never detected, so the stream silently stops). No HTTP contract change. Depends on 019 (it edits `HaEventHub` after 019 made it always-on; build after 019 to avoid conflicts).

## Assumptions (card was vague, marked on the card)
- "Mejora" = reliability + fewer/lighter calls to HA, not new HA features. Calling services over WebSocket instead of REST is out of scope.

## Requirements
- `HaClient.ts`: one internal `haRequest(method, path, body?, { retry })` used by `haGet`, `haPostText` and a new `haPostJson`. Keeps: token only in the header, never logged or echoed; `HaNotConfiguredError` / `HaUnauthorizedError` (401/403) / `HaUnexpectedResponseError` / `HaUnreachableError` mapping unchanged.
- Timeout from env `HA_TIMEOUT_MS` (int 1000..30000, default 5000; invalid -> default + one WARN at startup). README + `.env.example`.
- Retry: idempotent GETs only, ONE retry after 300 ms on network error, timeout or 502/503/504. POST (service calls, templates) never retried (a duplicated `open_cover` is not harmless).
- `fetchState(entityId)` -> `GET /api/states/<entity_id>`; HA 404 -> `null` (not an error). No more full-state download for one entity.
- `controlEntity` (003) uses the service reply: `haPostJson` returns HA's array of changed states; if it contains the entity, normalize that one; else fall back to one `fetchState`. The pre-check `fetchState` before the call stays (404 contract). Net effect per action: 2 small GETs max instead of 2 full `/api/states`.
- `CoverPercentService` / `CoverMoves` / presets (021, if present) use the new single `fetchState` (no code change needed if they already call it).
- `HaEventHub`: heartbeat. Every 30 s send `{ id: <n>, type: "ping" }`; no `pong` within 10 s -> `ws.close()` and the existing backoff reconnect (019 link `false` -> `true` events fire as usual). Message ids increment per socket (subscribe keeps id 1, pings start at 2). Timers cleared on close.
- `HaEventHub.onStateChanged`: when the area index fails, log WARN at most once per minute (today it is swallowed silently) and still emit with empty areas.
- No change to `/api/*` responses, error codes or Bruno contracts.

## Touches existing endpoints
no (same contract; internals of `POST /api/entities/:id/action`, `cover-percent`, `GET /api/stream`)

## Done when
**Unit (vitest, fetch mocked, fake WebSocket + fake timers)**
- `haRequest`: timeout env parsing (valid, invalid -> 5000); GET retried once on network error / 503 then succeeds; GET with 2 failures -> `ha_unreachable`; POST never retried; 401 -> unauthorized without retry; token never appears in thrown messages.
- `fetchState`: calls `/api/states/<id>`; 404 -> null.
- `controlEntity`: uses the entity from the service reply (no extra GET); reply without the entity -> one `fetchState`.
- Hub heartbeat: ping every 30 s; missing pong -> close + reconnect scheduled; pong received -> stays open.

**Bruno**
- Existing `entities/`, `areas/`, `stream/`, `history/`, `calibrations/` cover-percent requests green unchanged (contract untouched).

**E2E / manual (orchestrator)**
- Toggle the test switch from the panel: API log shows no `/api/states` full fetch for the action. Pull the HA host network for > 40 s: the stream reconnects by itself after it is back (no API restart). test.cjs green.
