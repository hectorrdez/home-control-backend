---
id: "004"
slug: areas
title: List areas with entities
role: backend
type: feature
extends: null
---

# List areas with entities

## Description
Give the panel the house structure: areas with the entities that belong to each.

## Requirements
- `GET /api/areas` returns `[{ areaId, name, entities: [normalized entity] }]`, plus an "unassigned" group.
- Reuse the normalization and area resolution from 002.
- Areas without entities are included with an empty list.

## Touches existing endpoints
no

## Done when
- Areas match what HA shows; every entity appears exactly once.
- Documented in endpoints.md and covered by Bruno.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
