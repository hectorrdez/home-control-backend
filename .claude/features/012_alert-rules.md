---
id: "012"
slug: alert-rules
title: Alert rules store (per entity, per trigger, with level)
role: backend
type: feature
extends: "008"
---

# Alert rules store (per entity, per trigger, with level)

## Description
Notification center (frontend 128/129): each device can have several alert rules, each with a trigger and a level (`off | low | medium | high`). Rules are shared by all clients and stored like aliases (008). Evaluation happens in the frontend from the SSE stream; this feature only stores rules.

## Requirements
- New module `alert-rules`: routes, controller, service, errors, file store reusing the 008/010 store pattern. Env `ALERT_RULES_FILE`, default `/data/alert-rules.json`, format `{ "version": 1, "rules": { "<ruleId>": { ... } } }`. Same Docker/README/.env.example treatment; record the persistence exception with `add-note.cjs`.
- Rule shape: `{ id (uuid, server-generated), entityId, trigger, level, message? }`. `trigger` is one of `{ type: "connects" }`, `{ type: "disconnects" }`, `{ type: "state_becomes", value: string 1..40 }`, `{ type: "above", value: number }`, `{ type: "below", value: number }`, `{ type: "interacted" }` (change caused by the user's own action). `level` in `off|low|medium|high`; `message` optional string 1..120.
- Endpoints: `GET /api/alert-rules` (optional `?entityId=`) -> `{ data: [rule] }` sorted by entityId then id; `POST /api/alert-rules` body without id -> created rule; `PUT /api/alert-rules/:id` replaces (same validation, id immutable) -> rule; `DELETE /api/alert-rules/:id` idempotent -> `{ data: [] }`.
- Validation: entityId regex `^[a-z_]+\.[a-z0-9_]+$` (`invalid_entity_id` 400); bad trigger/level/message -> `invalid_rule` 400; max 500 rules (`too_many_rules` 400); one rule per (entityId, trigger identity: type plus value) -> `duplicate_rule` 409; unknown id on PUT -> `rule_not_found` 404; write failure `alert_rules_write_failed` 500 (memory unchanged).
- Orphan rules (entity gone from HA) are kept; the entity may just be offline.
- Route + `endpoints.md` + Bruno (`tests/bruno/alert-rules/`, cleanup at the end) + vitest as ONE unit.

## Touches existing endpoints
no

## Done when
- Bruno + unit tests cover create/list/filter/replace/delete/validation/duplicate; test.cjs green.
