---
id: "014"
slug: pg-document-store
title: Move aliases, calibrations and alert rules from JSON files to Postgres
role: backend
type: change
extends: "012"
---

# Move aliases, calibrations and alert rules from JSON files to Postgres

## Description
Replaces the shared `JsonFileStore` (008/010/012) with a Postgres-backed store that keeps EXACTLY the same in-memory API, so the alias, calibration and alert-rule services, validations, endpoints and error codes do not change. Existing data in the old JSON files on the `/data` volume is imported once. Depends on 013.

## Requirements
- New `src/shared/PgDocumentStore.ts` `PgDocumentStore<V>` with the same public surface as `JsonFileStore<V>` except `load`: options `{ scope, collection, entryLabel, max, parseEntry, createWriteError, db?: Queryable }` (`db` defaults to the 013 pool; injectable for tests).
  - `async load(): Promise<void>` = `SELECT key, value FROM documents WHERE collection = $1 ORDER BY key`; each row goes through `parseEntry(key, value)`; invalid rows or rows over `max` are skipped and counted (`ignored N invalid <entryLabel> entries on load`, WARN, no contents logged). Never throws on bad rows; a db error throws (startup fails, see 013).
  - `entries()`, `get(key)` unchanged (memory, sorted by key).
  - `mutate(change)`: same serialized queue as `JsonFileStore`. Applies `change` to a copy; returns early when it returns false; else computes the diff vs current memory (added/changed keys by `JSON.stringify` comparison, removed keys) and in ONE transaction (`withTransaction` from 013) runs `INSERT ... ON CONFLICT (collection, key) DO UPDATE SET value = EXCLUDED.value, version = documents.version + 1, updated_at = now(), updated_by = $n` for each added/changed key and `DELETE` for removed keys; memory is swapped only after COMMIT. Any db error -> `Logger.error(message)` + throw `createWriteError()`; memory unchanged.
  - `mutate` accepts an optional second arg `{ by?: string | null }` stored in `updated_by` (016 passes the client id; default null).
  - Optional option `onChanged?: (keys: string[]) => void` called after a successful commit with the changed+removed keys (used by 016; no-op default).
- Legacy import `importLegacyJson(store, file)` in the same file: runs at startup right after `load()` ONLY when the collection is empty AND `file` exists. Reads it with the existing `JsonFileStore.load(file)` (reuses version check + parseEntry + quarantine), writes all entries in one transaction (same upsert), then renames the file to `<file>.imported-<epochMs>` and logs `imported N <entryLabel> entries from <basename>`. Import failure -> log, leave the file in place, keep starting (empty collection). Never imports twice (collection no longer empty; file renamed).
- Collections: `aliases` (key entityId), `calibrations` (key entityId), `alert_rules` (key rule uuid). `AliasStore`, `CalibrationStore`, `AlertRuleStore` swap `JsonFileStore` for `PgDocumentStore` (same options, `property` -> `collection`). `index.ts`: `await store.load()` + `await importLegacyJson(store, process.env.ALIASES_FILE || "/data/aliases.json")` (same for `CALIBRATIONS_FILE`, `ALERT_RULES_FILE`), after `migrate`, before `listen`.
- `JsonFileStore.ts` stays (used only by the importer). The 011 calibration position write path keeps working through the same `mutate`.
- No HTTP contract change: every existing Bruno request in `aliases/`, `calibrations/`, `alert-rules/`, `entities/` (cover-percent) must pass unchanged.
- Docs: README + `.env.example` describe `ALIASES_FILE`/`CALIBRATIONS_FILE`/`ALERT_RULES_FILE` as "legacy import source only". `add-note.cjs`: JSON stores replaced by `documents` table; import-once rule; file renamed `.imported-*`.

## Touches existing endpoints
no (same contract; storage only)

## Done when
**Unit (vitest, fake `Queryable`)**
- `load` parses rows, skips invalid ones and those over `max`, logs the count.
- `mutate`: insert / update / delete issue the right statements in one BEGIN/COMMIT; `change` returning false -> no query; db error -> ROLLBACK, configured write error thrown, `entries()` unchanged; concurrent mutations are serialized (second sees the first's result); `onChanged` gets the changed keys only after commit; `by` reaches `updated_by`.
- `importLegacyJson`: imports a valid v1 file and renames it; skips when collection not empty; skips when file missing; corrupt file -> quarantined by `JsonFileStore`, nothing imported; db failure -> file left in place.
- Existing alias/calibration/alert-rule service tests pass with the store mocked as before.

**Bruno**
- Existing `aliases/`, `calibrations/`, `alert-rules/`, cover-percent requests green unchanged.
- New `tests/bruno/persistence/` sequence (restart survival is checked manually below): PUT alias -> GET lists it -> DELETE -> GET without it.

**E2E / manual (orchestrator, Docker Desktop)**
- Put an old-format `aliases.json` in the data volume, start the stack -> GET /api/aliases returns its entries, file renamed `.imported-*`; `docker compose restart api` -> entries still there (from Postgres); restart again -> no second import.
- test.cjs green.
