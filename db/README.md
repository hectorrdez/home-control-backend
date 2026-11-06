# Database

MySQL 8 (InnoDB, utf8mb4). Connection config comes from `.env`
(`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS`). The pool lives in
`src/resources/utils/Connection.ts`; import the shared `db` singleton, never
`new Connection()`.

- `schema.sql`: tables, idempotent (`CREATE TABLE IF NOT EXISTS`).
- `seed.sql`: reference data, idempotent (`ON DUPLICATE KEY UPDATE`).

Docker loads both on a fresh volume (`docker compose ... up -d db`). Without
Docker:

```sh
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS app CHARACTER SET utf8mb4;"
mysql -u root -p app < db/schema.sql
mysql -u root -p app < db/seed.sql
```

Changing a shipped table = `ALTER` in `schema.sql` plus a note in `endpoints.md`
when it changes a contract.
