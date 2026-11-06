-- Application schema. Idempotent: CREATE TABLE IF NOT EXISTS, ids are CHAR(36) UUIDs.
-- Docker loads every *.sql in this folder (alphabetical) on a fresh volume.
-- Add domain tables below; create-project appends the auth tables when asked.

CREATE TABLE IF NOT EXISTS audit_events (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  actor_user_id  CHAR(36)     NULL,
  action         VARCHAR(100) NOT NULL,
  target_type    VARCHAR(50)  NULL,
  target_id      VARCHAR(64)  NULL,
  result         VARCHAR(20)  NOT NULL DEFAULT 'success',
  ip             VARCHAR(64)  NULL,
  metadata       JSON         NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_actor (actor_user_id),
  INDEX idx_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- <schema:tables>
