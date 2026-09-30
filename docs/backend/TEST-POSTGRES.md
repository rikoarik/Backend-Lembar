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

## Migration history

The runner applies SQL migrations in filename order from an empty schema.

`0019_indonesian_education_training.sql` declared
`id_grades.phase CHECK (phase IN ('A','B','C','D'))` while seeding Kurikulum
Merdeka phases E and F, so a fresh provision failed with
`new row for relation "id_grades" violates check constraint
"id_grades_phase_check"`. The constraint now admits A–F, matching both the seed
data and the later `0022_fix_id_grades_phase_constraint.sql` widening. Editing
the file does not re-run it on an existing database: Drizzle's migrator applies
by journal timestamp, not by content hash.

The environment and URL guard remain in place; this document deliberately does
not provide a bypass that could target a non-test database.

