---
id: "003"
slug: entity-control
title: Control entities
role: backend
type: feature
extends: null
---

# Control entities

## Description
Let clients act on a device (on, off, toggle, set attributes) through HA services, restricted by an allowlist of domains.

## Requirements
- `POST /api/entities/:entityId/action` body `{ action, params? }`, actions: turn_on, turn_off, toggle (plus params like brightness, temperature, position).
- Call HA `POST /api/services/<domain>/<service>` with `entity_id`.
- Allowlist of domains from notes.md; others -> typed ApiError (domain not allowed).
- Validate body; unknown entity -> typed not-found error.
- Return the entity's new normalized state.

## Touches existing endpoints
no

## Done when
- Toggling a real test entity changes its state and the response reflects it.
- Disallowed domain and bad payloads return typed errors.
- Documented in endpoints.md and covered by Bruno.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
