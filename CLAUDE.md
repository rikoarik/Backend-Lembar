# Claude Code Instructions — Backend-Lembar

Read and obey `AGENTS.md` before any task. Then read only the product/backend/contract files
listed by the exact task and `docs/backend/README.md`.

Context budget: exact task contract + maximum three referenced documents. Use Git diff and
test output as durable evidence; do not paste full documents or old handoffs into chat.

Hard rules:

- Start work only from an explicit `START B<id>` command.
- This repository is one backend modular monolith; do not create frontend or microservices.
- PostgreSQL is accepted; framework/auth/ORM/queue/storage/AI/payment/hosting choices require
  accepted decisions/ADRs.
- Claude Code/9Router routing is not product-runtime AI authorization and its credentials must
  never enter repository/env example/log/test/handoff.
- Tenant isolation, idempotency, stable contract, migration safety, and content/secret redaction
  are mandatory.
- Do not commit, push, open PR, merge, deploy, migrate production, or start next task unless the
  task/owner explicitly authorizes it.
- Preserve existing user work and stop on conflicting files/open decisions.
- End with `READY_FOR_OWNER_REVIEW` and the standard handoff, then wait.
- Never spawn another agent/task or reread the full documentation pack without explicit owner
  instruction.
