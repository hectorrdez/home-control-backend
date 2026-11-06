---
id: "002"
slug: entities-list
title: List entities
role: backend
type: feature
extends: null
---

# List entities

## Description
Expose Home Assistant entities in a normalized shape for the panel, with filters by domain and area.

## Requirements
- `GET /api/entities?domain=&area=` using HA states (`GET /api/states`).
- Normalized item: `{ entityId, domain, name, state, attributes (safe subset), area, lastChanged }`.
- Area resolved via HA template API (`POST /api/template`) or WebSocket registries; cache briefly.
- Unknown filter values return an empty array, not an error.

## Touches existing endpoints
no

## Done when
- Listing returns real entities, filters work, sorted by name.
- Documented in endpoints.md and covered by Bruno.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
