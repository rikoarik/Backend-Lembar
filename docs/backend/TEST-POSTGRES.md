# Isolated PostgreSQL integration tests

Run DB-gated Vitest suites only through:

```bash
pnpm test:db
```

The command starts the `lembar-test` Compose project and uses only the loopback-only database at `127.0.0.1:55432/lembar_test`. PostgreSQL data is stored in a container `tmpfs`; it is ephemeral and does not create a named volume. It does not read `.env` or use the local/development `DATABASE_URL`.

`prepare-test-db.mjs` refuses every URL except the fixed isolated test endpoint before it resets the test schema. It must never be run against a local, staging, or production URL.

The container is intentionally left running after a test run, so diagnostics are possible. Remove only this isolated project when finished:

```bash
docker compose -p lembar-test -f compose.test.yaml down
```

Do not use `docker compose down -v`, and do not stop or remove unrelated containers, databases, or volumes.

## Current migration blocker

The runner applies SQL migrations in filename order from an empty schema. At the current revision that fails at the later marketing migration with `column "revision" of relation "marketing_content" already exists`. This is a migration-history defect, not an environment or connectivity defect. Resolve migration ordering/idempotency before treating `pnpm test:db` as a green quality gate.

The environment and URL guard are still usable for focused suites after preparing a compatible schema, but this document deliberately does not provide a bypass that could target a non-test database.
