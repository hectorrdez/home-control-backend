# Project notes - constraints and learnings
# Append-only via add-note.cjs. Read before building. Reuse what's here; don't repeat past mistakes.
# Content can be in any language; this file is yours.
- HA is reached at HA_URL (LAN) with Authorization: Bearer HA_TOKEN (long-lived token). HA_TOKEN is user-provided via .env; never print it, never commit it. API_TOKEN is a DIFFERENT token: the key the frontend sends to this API (gate in src/shared/guards/apiKey.ts, Authorization: Bearer).
- Control only HA domains in the allowlist (light, switch, climate, cover, fan, media_player, scene, script); anything else -> typed ApiError (not allowed).
- Template envelope: data is always an array; use route() + ApiError subclasses. Model/Repository layer is DB-bound and unused here; HA access goes through a dedicated client module, not Repository.
- Bruno tests run against a live API that needs a reachable HA. Until a mock/real HA is available in CI, tests hit the real homelab HA on LAN (read-only calls preferred; control tests only on a dedicated test entity).
- TOKEN LOCATION: the user keeps the HA long-lived token as HA_TOKEN in F:\proyectos\home-control\.env (parent folder, outside every repo, never committed). Backend reads HA_TOKEN: copy it to home-control-backend/.env for local dev and to the Dokploy env of the backend app for deploy. NEVER put it in the frontend (Vite would bundle VITE_* vars), docs repo or Electron. Do not print it.
- TOKENS: API_TOKEN = shared key the frontend (web build and Electron) sends to THIS API as Authorization: Bearer <API_TOKEN>; HA_TOKEN = long-lived token THIS API uses against Home Assistant. Both live in F:\proyectos\home-control\.env. Backend .env gets both; frontend only gets API_TOKEN (as VITE_API_TOKEN); HA_TOKEN never leaves the backend.
