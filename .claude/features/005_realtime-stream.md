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
- Single shared HA WebSocket connection for all clients (auth with HA_TOKEN), automatic reconnect with backoff.
- Heartbeat comment to keep proxies (Caddy) from closing the stream; clean up on client disconnect.
- Optional `?domain=` filter.

## Touches existing endpoints
no

## Done when
- Changing a real entity in HA produces an event in the stream within seconds.
- Reconnects after HA restart; no leaks after clients disconnect.
- Documented in endpoints.md; Bruno covers connection and first event/heartbeat.
- test.cjs is green (the real gate; mark-ended.cjs enforces it).
