---
id: "007"
slug: history
title: State history of entities
role: backend
type: feature
extends: null
---

# State history of entities

## Description
Let the panel draw small charts of how entities changed over time (e.g. a temperature or a switch over the last day), using Home Assistant's own recorder history through the existing HA client.

## Requirements
- `GET /api/history?entityIds=a,b&hours=24` returns `{ data: [{ entityId, points: [{ t, v }] }] }`, one item per requested entity, in request order. `t` = ISO 8601 timestamp of the change, `v` = state string.
- Source: HA `GET /api/history/period/<start>?filter_entity_id=...&end_time=...&minimal_response&significant_changes_only`, reusing `haGet` from `src/modules/ha/HaClient.ts`. No new HA client.
- Requested entities with no recorded history appear with `points: []`; HA results are matched back by `entity_id` (in minimal_response only the first state of each series carries it).
- Validation: `entityIds` required, non-empty after trimming, max 20 distinct ids, each must match the entity id regex `^[a-z_]+\.[a-z0-9_]+$`. `hours` is an integer 1..720, default 24.
- Typed ApiError subclasses with stable errorCodes (e.g. `invalid_entity_id` 400, `too_many_entities` 400, `invalid_hours` 400). No domain allowlist (read-only).
- Reuse the normalization conventions from 002 (ISO timestamps, no HA internals exposed). Never log or echo the token.

## Touches existing endpoints
no

## Done when
- A real entity with recorded history returns ordered points; an entity without history returns `points: []`.
- Invalid entityIds, more than 20 ids, and hours out of range each return the typed error envelope.
- Documented in endpoints.md and covered by Bruno (happy path + each validation error).
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
