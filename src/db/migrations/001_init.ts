import type { Migration } from "./index";

const migration: Migration = {
  version: 1,
  name: "init",
  up: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Generic keyed documents: aliases, calibrations, alert rules, settings.
CREATE TABLE documents (
  collection text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NULL,
  PRIMARY KEY (collection, key)
);

CREATE TABLE events (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  source text NOT NULL,
  client_id text NULL,
  client_name text NULL,
  entity_id text NULL,
  level text NULL,
  payload jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX events_ts_idx ON events (ts DESC);
CREATE INDEX events_type_ts_idx ON events (type, ts DESC);
CREATE INDEX events_entity_ts_idx ON events (entity_id, ts DESC);

CREATE TABLE alerts (
  id uuid PRIMARY KEY,
  rule_id uuid NULL,
  entity_id text NOT NULL,
  level text NOT NULL,
  text text NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  acked_at timestamptz NULL,
  acked_by text NULL
);
CREATE INDEX alerts_open_idx ON alerts (fired_at DESC) WHERE acked_at IS NULL;
`,
};

export default migration;
