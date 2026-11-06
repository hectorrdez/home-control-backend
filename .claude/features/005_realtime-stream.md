---
id: "005"
slug: realtime-stream
title: Real-time state stream
role: backend
type: feature
extends: null
---

# Real-time state stream

## Description
Push state changes to clients so the panel updates without polling.

## Requirements
- `GET /api/stream` as Server-Sent Events, emitting normalized entity updates from HA WebSocket `state_changed`.
- Auth: the same API key gate as the rest of `/api` (`Authorization: Bearer <API_TOKEN>`), plus, for this route only, `?token=<API_TOKEN>` in the query, because browser `EventSource` cannot send an Authorization header. Compare with `timingSafeEqual` (constant time), same as the header path. Missing or wrong token -> typed `NotAuthorizedError` / `MissingCredentialsError` envelope.
- The token is never logged: any log line about this request uses the path only, never the query string; never echoed in responses.
- Single shared HA WebSocket connection for all clients (auth with HA_TOKEN), automatic reconnect with backoff.
- Heartbeat comment to keep proxies (Caddy) from closing the stream; clean up on client disconnect.
- Optional `?domain=` filter (validated: `^[a-z_]+$`, else typed `invalid_domain` 400 before the stream opens).
- First frame is `event: ready`. Optional `?once=1` sends that frame and closes the response: a smoke-test mode, because Bruno cannot read an open stream.

## Touches existing endpoints
no

## Done when
- Changing a real entity in HA produces an event in the stream within seconds.
- Reconnects after HA restart; no leaks after clients disconnect.
- `GET /api/stream?token=<API_TOKEN>` opens the stream; wrong or missing token is rejected with the typed envelope; the token never appears in logs or responses.
- Documented in endpoints.md (auth column notes the `?token=` fallback); Bruno covers connection and first event/heartbeat, plus a rejected token case.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
