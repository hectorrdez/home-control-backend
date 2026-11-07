---
id: "020"
slug: server-alerts
title: Server-side alert engine, shared alerts with acknowledge
role: backend
type: change
extends: "012"
---

# Server-side alert engine, shared alerts with acknowledge

## Description
Alert rules (012) are evaluated today in each browser (frontend 129): alerts only exist while a panel is open, every open panel raises its own copy, and dismissing on one device does not dismiss on the others. This feature moves evaluation to the API, on the always-on HA link (019). Each firing is stored once in the `alerts` table (013), logged in `events` (018) and pushed to every panel (`alert` SSE event); acknowledging it on one device acknowledges it everywhere (`alert_acked`). Depends on 019. Frontend counterpart: the `server-alerts` frontend feature (extends 129).

## Requirements
- `src/modules/alerts/engine.ts`: pure port of frontend `src/features/alerts/engine.ts` (`fires`, `evaluate`, DEDUPE 2 s per rule) and of the trigger label + unit helpers from frontend `src/features/alerts/rules.ts` and the `isUnavailable` rule from frontend `src/state/availability.ts` (copy behaviour exactly; read those files). Same triggers: `connects`, `disconnects`, `state_becomes`, `above`/`below` (fire on crossing only, re-arm when back), `interacted`. Level `off` never fires.
- `interacted` server-side: the action controller (018 hook point) records `{ entityId, clientId, clientName, at }` in an in-memory `RecentActions` map when an action/cover-percent succeeds; a `state_changed` of that entity within 10 s counts as interacted (entry consumed). The alert carries `clientId`/`clientName` of the initiator.
- `AlertService` subscribed to the hub (019) with the rules from `AlertRuleStore` (014, memory). Keeps the previous normalized entity per entity id (seeded silently, like the 019 recorder; no alerts on seeding or on reconnect snapshot). On each change: `evaluate` -> for each firing insert into `alerts` (`id` uuid, `rule_id`, `entity_id`, `level`, `text`, `fired_at`), `eventLog.record({ type: "alert", source: "engine", entityId, level, payload: { alertId, ruleId, text, trigger } })`, and app event `{ type: "alert", alert }` -> SSE `event: alert`.
- API shape: `{ id, ruleId, entityId, level: "low"|"medium"|"high", text, firedAt, ackedAt: string|null, ackedBy: string|null, clientId: string|null }` (clientId = initiator for interacted, else null; stored in the events payload, returned null if unknown on list).
- Endpoints (Bearer API_TOKEN):
  - `GET /api/alerts?status=open|all&limit=` -> `{ data: [alert] }` newest first; `status` default `open` (acked_at IS NULL, and fired within the last 24 h), `limit` 1..200 default 50. Bad params -> `invalid_query` 400.
  - `POST /api/alerts/:id/ack` -> `{ data: [alert] }` with `ackedAt` now and `ackedBy` = `res.locals.clientId`; already acked -> 200 unchanged (idempotent, keeps the first ack); unknown/invalid uuid -> `alert_not_found` 404. Emits app event `{ type: "alert_acked", id, ackedAt, ackedBy }` -> SSE `event: alert_acked` (only on the first ack) and logs `alert_acked` event.
  - `POST /api/alerts/ack-all` -> acks every open alert, returns `{ data: [acked alerts] }`, one `alert_acked` frame per alert.
- Test hook (non-production only, `NODE_ENV !== "production"`): `POST /api/alerts/test-fire` body `{ entityId, level, text }` -> inserts + emits like a real firing (Bruno needs it; HA cannot be forced). In production the route does not exist (404).
- Rules CRUD (012) unchanged. Retention from 018 also prunes acked alerts.
- `endpoints.md` rows + stream row (`alert`, `alert_acked`). `add-note.cjs`: evaluation now server-side; frontend must stop local evaluation when `/api/alerts` exists.

## Touches existing endpoints
yes: `GET /api/stream` (new frames). `POST /api/entities/:entityId/action` / `cover-percent` feed `RecentActions` (response unchanged).

## Done when
**Unit (vitest)**
- Engine parity table copied from the frontend engine tests (every trigger, crossing + re-arm, off never fires, dedupe 2 s).
- AlertService: no firing on seeding/snapshot; firing inserts, logs and emits once; interacted only within 10 s of a successful action of that entity and carries the client id; rule changes (read from store memory on every evaluation) apply without restart.
- Ack: first ack sets fields + emits; second ack no emit; ack-all.

**Bruno** (`tests/bruno/alerts/`)
- test-fire medium -> 200; `GET /api/alerts` contains it with `ackedAt: null`; ack with `X-Client-Id` -> `ackedBy` set; ack again -> 200 same `ackedAt`; `GET /api/alerts` (open) no longer contains it; `status=all` does; `GET /api/events?types=alert,alert_acked&limit=5` has both; ack random uuid -> 404; `status=bad` -> 400; no token -> 401.

**E2E / manual**
- Two browsers / two `curl -N` streams: test-fire -> both get `alert`; ack from one -> both get `alert_acked`. With a real rule (`state_becomes on` on the test switch) and NO panel open, toggling it in HA creates an open alert visible later via GET. test.cjs green.
