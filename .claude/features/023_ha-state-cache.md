---
id: "023"
slug: ha-state-cache
title: In-memory HA state + registry cache fed by the WebSocket
role: backend
type: change
extends: "019"
---

# In-memory HA state + registry cache fed by the WebSocket

## Description
Second half of "Mejora de interaccion con la api de HA". With the HA WebSocket always open (019) the API can keep the current state of every entity in memory instead of asking HA on every `GET /api/entities` / `GET /api/areas` / control pre-check. Areas and device names are today resolved by polling Jinja templates every 30/60 s (`fetchAreaIndex`, `fetchAreaList`, `fetchDeviceNameIndex`); HA's registry commands over the WebSocket give the same data and push an event when it changes, so renames/moves in HA show at once instead of after the cache TTL. REST stays as the fallback when the link is down. No HTTP contract change. Depends on 019 and 022.

## Assumptions (card was vague, marked on the card)
- Scope = read path only (states, areas, device names). Service calls stay on REST (022).

## Requirements
- `src/modules/ha/HaCache.ts` (singleton), fed by `HaEventHub`:
  - On every `auth_ok`: send `get_states`, `config/area_registry/list`, `config/device_registry/list`, `config/entity_registry/list` (incrementing ids, after 022 pings scheme), and `subscribe_events` for `area_registry_updated`, `device_registry_updated`, `entity_registry_updated` (in addition to `state_changed`).
  - States map `entity_id -> HaState` replaced by the `get_states` result, then updated by each `state_changed` (`new_state: null` = entity removed -> delete).
  - Area index: entity -> area = entity registry `area_id`, else the area of its device (device registry `area_id`); area names from the area registry. Device name = `name_by_user || name`. Same `AreaRef` / `Map` shapes as today so `normalizeEntity` is unchanged.
  - A `*_registry_updated` event -> re-request only that registry list (debounce 1 s).
  - `ready` flag true after the first full load on the current socket; false on close.
- `HaStates.ts`: `fetchStates`, `fetchState`, `fetchAreaIndex`, `fetchAreaList`, `fetchDeviceNameIndex` read from `HaCache` when `ready`; otherwise use today's REST/template path (with its TTL caches). Callers (entities, areas, history, covers, presets, stream, alerts) do not change.
- Consistency guard: an action response (022) and the following `state_changed` must not regress the cache: apply a state only if its `last_updated` is >= the cached one.
- Memory bound: states only for entities HA reports (no growth beyond HA's count); registries replaced, not appended.
- Logs: INFO once per load with counts (`ha cache ready: N states, A areas, D devices`), no attribute contents, token never logged.
- `GET /api/health` (013): add `haCache: "ready" | "warming" | "off"` (additive field, always 200).
- `add-note.cjs`: read path served from WS cache when ready, REST fallback; templates only used when cache not ready.

## Touches existing endpoints
yes (additive): `GET /api/health` gains `haCache`. `GET /api/entities`, `GET /api/areas`, `GET /api/stream`, action/cover-percent responses: same shape, now served from memory when the cache is ready.

## Done when
**Unit (vitest, fake WebSocket)**
- Load sequence on `auth_ok` sends the 4 list commands + registry subscriptions; `ready` only after all replies.
- Area resolution: entity area wins over device area; device area used when entity has none; names from area registry; device name `name_by_user` over `name`.
- `state_changed` updates/deletes; older `last_updated` ignored; registry updated event re-requests only that list (debounced).
- `HaStates` readers use the cache when ready, REST path when not (mock both).

**Bruno**
- All existing `entities/`, `areas/`, `stream/`, `health` requests green; `GET /api/health` has `haCache` in `ready|warming|off`.

**E2E / manual (orchestrator)**
- Rename a device / move an entity to another area in HA: `GET /api/entities` shows it within ~2 s (no 60 s wait). Stop HA: `/api/health` -> `haCache: "warming"` or `"off"` and `/api/entities` returns `ha_unreachable` as before (REST fallback). test.cjs green.
