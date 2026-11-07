---
id: "016"
slug: change-bus-sse
title: Client identity + resource_changed events on the SSE stream
role: backend
type: change
extends: "005"
---

# Client identity + resource_changed events on the SSE stream

## Description
Cross-device sync needs two things: knowing which device made a change, and telling every other open panel that something changed. This feature adds an optional client identity (headers) and an in-process change bus whose events go out on the EXISTING `GET /api/stream` as a new SSE event `resource_changed`. Clients then refetch the resource. Wired to aliases, calibrations and alert rules now; settings (017) and the event log (018) plug into the same bus. Depends on 014.

## Requirements
- Client identity middleware `src/shared/http/clientIdentity.ts` mounted in `app.ts` before the router: reads `X-Client-Id` (must match UUID v4-ish `^[0-9a-f-]{36}$` case-insensitive, else ignored) and `X-Client-Name` (trim, strip control chars, max 40 chars, else ignored) into `res.locals.clientId` / `res.locals.clientName` (null when absent). Never required, never an error. For `GET /api/stream` (EventSource cannot send headers) also accept `?clientId=` with the same rule. Never log either value together with the token.
- CORS: `cors` already reflects requested headers; add an explicit `allowedHeaders` only if needed so `Authorization, Content-Type, X-Client-Id, X-Client-Name` pass preflight from `CORS_ORIGINS`.
- `src/shared/events/AppEvents.ts`: a typed singleton `appEvents` (Node `EventEmitter`, `setMaxListeners(0)`) with `emit(evt)` / `subscribe(fn): () => void`. Event union for now: `{ type: "resource_changed", resource: "aliases" | "calibrations" | "alert_rules" | "settings", keys: string[], by: string | null }` (`by` = client id). Later features extend the union (018 `event`, 019 `ha_link`, 020 `alert` / `alert_acked`).
- Emit: `AliasStore`, `CalibrationStore`, `AlertRuleStore` pass `onChanged` (014) that emits `resource_changed` with their resource name and the changed keys; services pass `{ by: res.locals.clientId }` to `mutate` (controllers forward it). The 011 timer-driven calibration position write also emits (`by: null`).
- `StreamController`: besides the HA hub subscription, subscribe to `appEvents` and write each app event as SSE `event: <type>` + `data: <json without "type">`. App events ignore the `domain` filter (they are not entity events). Unsubscribe on close like today. `once=1` unchanged.
- No debounce server-side (clients may coalesce). Bounded payload: `keys` capped at 100 entries (if more, send `keys: []` meaning "refetch all").
- `endpoints.md`: stream row documents `resource_changed` + `?clientId=`; new table section "Client identity headers".

## Touches existing endpoints
yes: `GET /api/stream` (new event type, new optional `clientId` query). `PUT/DELETE /api/aliases/:entityId`, `PUT/DELETE /api/calibrations/:entityId`, `POST/PUT/DELETE /api/alert-rules[/:id]` behave the same but now also emit. Old Bruno requests must pass unchanged.

## Done when
**Unit (vitest)**
- clientIdentity: valid headers stored; bad id / overlong or control-char name ignored; `?clientId=` accepted only on `/api/stream`.
- AppEvents subscribe/unsubscribe; StreamController writes `event: resource_changed` frames (mocked res) and ignores the domain filter for them; unsubscribes on close.
- Each store emits once per successful mutate with the right resource/keys/by; no emit when nothing changed or on write failure.

**Bruno**
- `tests/bruno/stream/stream-once-client-id.bru`: `?once=1&clientId=<uuid>` -> 200 + `ready` (identity does not break the smoke mode).
- Alias PUT with `X-Client-Id` header -> 200 (header accepted); with a bad `X-Client-Id` -> still 200.

**E2E / manual (orchestrator)**
- Two `curl -N /api/stream?token=...` terminals; PUT an alias in a third -> both receive `event: resource_changed` with `resource":"aliases"`. test.cjs green.
