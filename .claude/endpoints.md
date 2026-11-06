# API endpoints - contract
# [backend] Append a row when you add an endpoint; regenerate a row when you change one.
#           Keep this in sync with the route + the Bruno request as ONE atomic change.
# [frontend] Read-only copy brought from the backend repo. Do not edit here.

| Method | Path | Auth | Request | Response | Notes |
|--------|------|------|---------|----------|-------|
| GET | /api/health | none | - | `{ data: [{ online: true }] }` | Liveness only (template). |
| GET | /api/ha/status | Bearer API_TOKEN | - | `{ data: [{ online: true, message, version }] }` | Checks HA link (`GET /api/` + `GET /api/config`). Errors: `ha_not_configured` 503, `ha_unreachable` 503, `ha_unauthorized` 502, `ha_unexpected_response` 502. |
| GET | /api/entities?domain=&area= | Bearer API_TOKEN | query: `domain` (HA domain), `area` (area id) both optional | `{ data: [{ entityId, domain, name, state, attributes, area, areaName, lastChanged }] }` sorted by name | `area` = HA area id or null; `attributes` = safe subset. Unknown filter -> `[]`. Area via HA `/api/template`, cached 30s. |
| POST | /api/entities/:entityId/action | Bearer API_TOKEN | `{ "action": "turn_on"\|"turn_off"\|"toggle", "params"?: { brightness, color_temp, temperature, position, percentage, hvac_mode, volume_level } }` | `{ data: [normalized entity] }` (new state) | Domains allowlist: light, switch, climate, cover, fan, media_player, scene, script. Errors: `invalid_entity_id` 400, `invalid_action` 400, `invalid_params` 400, `domain_not_allowed` 403, `entity_not_found` 404. |
