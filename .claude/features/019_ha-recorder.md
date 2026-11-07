---
id: "019"
slug: ha-recorder
title: Always-on HA link, availability and link events
role: backend
type: change
extends: "005"
---

# Always-on HA link, availability and link events

## Description
Today the HA WebSocket (005 `HaEventHub`) only lives while a panel is open, so nothing is observed when no device is looking. This feature keeps it open permanently (server-side recorder) and logs device availability transitions and HA link up/down into the event log (018). It also tells panels when the backend lost HA (`ha_link` SSE event), closing the gap noted in frontend 126. Prerequisite for server-side alerts (020). Depends on 018.

## Requirements
- `HaEventHub`: add `keepAlive()` called once from `index.ts` after startup: registers a permanent internal listener so the socket is opened at boot and reconnects forever with the existing backoff; SSE client subscribe/unsubscribe no longer closes it. No change to auth/token handling; token never logged.
- Hub exposes `onLink(fn: (connected: boolean) => void)`: `true` after `auth_ok`, `false` on close/auth_invalid (only on real transitions, not repeated). Each transition -> `eventLog.record({ type: "ha_link", source: "ha", payload: { connected } })` and app event `{ type: "ha_link", connected, at }` -> SSE `event: ha_link`. New SSE clients get the current link state right after `ready` as one `ha_link` frame.
- Availability recorder `src/modules/events/AvailabilityRecorder.ts`: keeps last known state per entity in memory (seeded silently from the first event per entity and, on every (re)connect, from one `GET /api/states` snapshot via the existing HA client; seeding never logs). On `state_changed` where the state moves to `unavailable` (from anything else) -> record `availability` with payload `{ available: false, from: <old state> }`; from `unavailable` to anything else -> `{ available: true, to: <new state> }`. `entityId` set, `source: "ha"`, no client id. A transition missed while the link was down is detected by the snapshot diff on reconnect and logged with payload `resync: true`.
- Noise guard: at most one `availability` event per entity per 10 s (drop extras, keep the latest state in memory).
- `endpoints.md`: stream row documents `ha_link`; events row lists types `ha_link`, `availability`.

## Touches existing endpoints
yes: `GET /api/stream` (new `ha_link` frame after `ready`; HA socket lifecycle no longer tied to clients). Existing stream Bruno requests must pass unchanged (`once=1` still sends only `ready` and closes: do NOT send `ha_link` in once mode).

## Done when
**Unit (vitest)**
- Hub with a fake WebSocket: `keepAlive` opens at start; last SSE unsubscribe does not close; link callbacks fire once per transition; reconnect backoff unchanged.
- AvailabilityRecorder: first sighting silent; to/from unavailable recorded; other changes ignored; 10 s guard; reconnect snapshot diff records missed transitions with `resync: true`, silent seeding on the first snapshot.
- StreamController sends `ha_link` after `ready` (not in once mode).

**Bruno**
- Existing `stream/` requests green unchanged.
- `GET /api/events?types=ha_link&limit=1` after API start -> one event with `payload.connected === true` (the boot connection).

**E2E / manual (orchestrator)**
- With no panel open, unplug a test device (or disable it in HA) -> `availability` event appears in `GET /api/events`. Restart HA container -> `ha_link false` then `true` events; an open `curl -N` stream shows both frames. test.cjs green.
