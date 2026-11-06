# API endpoints - contract
# [backend] Append a row when you add an endpoint; regenerate a row when you change one.
#           Keep this in sync with the route + the Bruno request as ONE atomic change.
# [frontend] Read-only copy brought from the backend repo. Do not edit here.

| Method | Path | Auth | Request | Response | Notes |
|--------|------|------|---------|----------|-------|
| GET | /api/health | none | - | `{ data: [{ online: true }] }` | Liveness only (template). |
| GET | /api/ha/status | Bearer API_TOKEN | - | `{ data: [{ online: true, message, version }] }` | Checks HA link (`GET /api/` + `GET /api/config`). Errors: `ha_not_configured` 503, `ha_unreachable` 503, `ha_unauthorized` 502, `ha_unexpected_response` 502. |
