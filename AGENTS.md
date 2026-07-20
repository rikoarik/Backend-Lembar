# AGENTS.md — Backend-Lembar

## Project boundary

This repository is the complete `lembar` backend modular monolith. It contains API and worker
entrypoints in one codebase. Do not create microservices or frontend application code here.

Read the exact task contract first, then at most three directly relevant documents named by
that contract. Do not preload the complete PRD/backend pack. Executable OpenAPI counts as one
document when the task changes or consumes the API.

## Operating rule

The owner grants standing authorization to the active Backend-Lembar orchestrator to issue `START <BACKEND-TASK-ID>` automatically for every eligible task in TASK-REGISTRY.yaml. A START command issued by the orchestrator under this authorization is equivalent to an explicit owner START command.

Before issuing START, the orchestrator must verify that the task exists, its dependencies and integration gates are satisfied, it is not already active or completed, its ownership does not conflict with another active task, and it does not require a genuine material owner decision.

The orchestrator must not wait for the owner to manually send START commands for routine eligible tasks.

Additional constraints:

- Up to 5 genuinely independent backend tasks may be `in_progress` concurrently.
- Do not start tasks that require open provider, pricing, auth, queue, ORM, security, or scope decisions.
- Workers hand off at task completion; the orchestrator reviews, integrates, and continues automatically.
- Request owner review only when the complete Backend-Lembar Web V1 scope is implemented, verified, CI-green, and landed on dev.

## Source precedence

Owner accepted decision/ADR > PRD > FRD > executable OpenAPI > backend architecture > task
notes/prototype. Never import architecture, provider, env, or endpoint from another project.

## Architecture constraints

- PostgreSQL is accepted. Use TypeScript, framework, HTTP adapter, ORM, and queue only after
  their corresponding decision IDs are `Accepted`.
- One repo/codebase/database; API and worker are process entrypoints, not microservices.
- Modules do not communicate over internal HTTP.
- Backend owns OpenAPI and publishes generated contract artifacts.
- All tenant data access requires verified workspace context.
- Long AI/source/PDF tasks run through idempotent worker flow.
- Product-runtime AI is accessed only through a backend provider adapter. Agent-orchestration
  routing such as 9Router does not authorize the same provider inside the product.
- No production secret required for local build/unit tests.
- Env schemas are per process; do not give every secret to every runtime.

## Security constraints

- Never log secret, session/token, source content, prompt, question text, signed URL, or raw
  provider error by default.
- Do not invent auth/crypto primitives.
- Uploads are untrusted and private.
- Superadmin/support access is explicit and audited.
- IDs do not replace authorization.
- Migrations preserve data and require rollback/forward-fix notes.

## Quality gates

Run exact repository scripts covering install, typecheck, lint, format, unit, PostgreSQL
integration, tenant adversarial tests, OpenAPI validation/breaking check, build API/worker,
secret scan, and smoke tests. Provider calls are mocked in normal CI.

Never weaken a gate, skip tenant tests, or exclude secret patterns merely to pass CI without
explicit review.

## Change discipline

- Preserve owner/unrelated changes.
- Schema change includes migration, constraints/index rationale, test, and compatibility.
- API change updates OpenAPI/examples/contract tests and declares consumer impact.
- New env var includes correct process schema, example, docs, redaction classification.
- New dependency/provider/service requires task need and relevant decision.

## Handoff

Use `docs/contracts/HANDOFF-TEMPLATE.md`. Include exact commands, migration/contract/security
impact, evidence, rollback, limitations, and non-scope. Then stop.
