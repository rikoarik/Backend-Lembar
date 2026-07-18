# Backend Architecture — Backend-Lembar

## Architecture statement

`Backend-Lembar` is a proposed TypeScript modular monolith with one repository, one package/lockfile, one
domain model, and one PostgreSQL database. It exposes an API process and a worker process from
the same source tree and release artifact.

No internal HTTP calls between domain modules. Modules call application interfaces or publish
transactional events. New services/repositories require an ADR and measured trigger.

Marketing content follows the same rule: one module in this monolith, PostgreSQL persistence,
public/ops HTTP adapters, existing auth/audit, and no separate CMS deployment. See
MARKETING-CMS-BACKEND.md.

## Goals

- Safe multi-tenancy.
- Strong transaction and idempotency behavior.
- Long AI/PDF work does not block HTTP requests.
- API contract supports separate frontend and future mobile.
- Provider and infrastructure choices can change behind adapters.
- Operable by a small team on modest infrastructure.
- Marketing CMS remains a low-cost in-process module with no queue/Redis requirement.

## Stack direction

| Area           | Direction                                                         |
| -------------- | ----------------------------------------------------------------- |
| Runtime        | Supported Node LTS selected/pinned at bootstrap                   |
| Language       | Proposed TypeScript strict; D-014                                 |
| HTTP framework | Open D-016: direct Fastify vs NestJS+Fastify; benchmark footprint |
| API            | Proposed REST, OpenAPI 3.1, `/v1`; D-017                          |
| Database       | PostgreSQL stable supported release                               |
| ORM/query      | Open decision D-003; spike before domain schema                   |
| Queue          | Open decision D-004; BullMQ/Redis vs PostgreSQL-backed queue      |
| Object storage | Private S3-compatible adapter                                     |
| AI             | Product-provider adapter; direct OpenAI proposed, D-019            |
| Validation     | Runtime DTO/schema validation at trust boundaries                 |
| PDF            | Proposed versioned HTML/CSS + Playwright worker; D-020             |
| Tests          | Vitest/Jest-compatible Nest testing + integration DB + HTTP tests |
| Observability  | Structured logs, metrics, traces, error tracker adapter           |
| Delivery       | Docker image with api/worker commands; CI/CD provider-neutral     |

Do not hardcode dependency major versions in architecture docs. Bootstrap pins stable versions
in lockfile after compatibility checks.

## Repository layout

```text
src/
  bootstrap/
    api.ts
    worker.ts
  config/
    base.env.ts
    api.env.ts
    worker.env.ts
  modules/
    identity/
    workspace/
    catalog/
    source/
    assessment/
    generation/
    quality/
    output/
    library/
    commerce/
    operations/
  infrastructure/
    database/
    queue/
    storage/
    ai/
    mail/
    observability/
  common/
    http/
    errors/
    idempotency/
    security/
contracts/
  openapi/
  schemas/
prisma-or-migrations/
test/
docs/
```

Domain module owns its aggregate/application service/repository interface. Infrastructure
implements interfaces. Shared `common` must remain small; it is not a dumping ground.

## Module boundaries

The module catalog includes marketing-content alongside identity, workspace, catalog,
assessment, generation, output, commerce, and operations. Marketing-content exposes
application commands/queries; other modules do not read its tables directly.

### Lightweight implementation rules

- Do not require worker, queue, Redis, object storage, or provider SDK for public CMS text.
- Public read is an indexed published-version lookup with ETag/cache headers.
- Prefer one cohesive module over generic repository/service layers copied for every entity.
- Create an abstraction only for a proven second consumer or a security/transaction boundary.
- Framework and ORM remain governed by D-016/D-003; CMS scope does not silently decide them.

| Module     | Owns                                                          |
| ---------- | ------------------------------------------------------------- |
| Identity   | Account/session/recovery/activation integration               |
| Workspace  | Workspace, membership, role, tenant context                   |
| Catalog    | Curriculum versions, grades, subjects, materials              |
| Source     | Upload, scan, extraction, passages, retention                 |
| Assessment | Config, versions, blueprint, questions, review/finalize       |
| Generation | Job orchestration, idempotency, AI adapter, quota reservation |
| Quality    | Deterministic/model checks and issue lifecycle                |
| Output     | Print model, export artifact, share link                      |
| Library    | History read model, bank, templates                           |
| Commerce   | Plan, entitlement, subscription, quota ledger                 |
| Operations | Feature flag, support action, audit, incident controls        |

Direct cross-module table access is disallowed by convention. Read models may join data through
documented query services where performance justifies it.

## Request lifecycle

1. Request ID and safe logging context.
2. Authentication/session resolution.
3. CSRF/origin validation for browser mutation.
4. Workspace context + membership/role verification.
5. DTO/schema validation.
6. Application service + transaction.
7. Stable response/error mapping.
8. Audit/domain event/outbox when relevant.

Guards do not replace authorization checks inside application services for sensitive operations.

## Generation lifecycle

1. API validates config, source readiness, entitlement, and membership.
2. Transaction creates draft, job, idempotency record, quota reservation, and outbox message.
3. Worker claims the message exactly-once-effect through idempotent state transition.
4. Worker retrieves source passages and builds a versioned prompt/input.
5. Selected AI adapter returns schema-constrained output.
6. Schema + deterministic quality checks run.
7. Partial result/check issues are stored transactionally.
8. Successful quota units commit; failed reservation releases.
9. API exposes neutral job state; no raw provider error.

Queue delivery can be at-least-once; business effects must still be idempotent.

## Export lifecycle

1. Only final version is exportable as final artifact.
2. Request uses idempotency key and content/template checksum.
3. Existing matching artifact is reused if authorized and valid.
4. Worker renders safe HTML, then Playwright PDF.
5. Artifact uploaded private with metadata/checksum.
6. Authorized request receives short-lived signed download.

## Data topology

- One PostgreSQL database and schema baseline.
- Tenant tables carry `workspace_id`.
- Application runtime uses least-privilege DB role, never owner/superuser.
- Authorization is enforced in application/repository layer.
- PostgreSQL RLS may be added as defense-in-depth after a proven integration pattern.
- Production data is never copied to local/preview.

## API governance

- Backend owns and validates OpenAPI.
- Operation IDs are stable and unique.
- Frontend client generated in CI from a published artifact.
- Breaking changes require compatibility plan.
- Error codes are stable; internal exceptions are never serialized.
- Swagger explorer, if enabled, is disabled/protected in production.

## Configuration boundaries

Do not parse one global schema that forces every process to receive every secret.

- `baseEnv`: runtime mode, log level, service identity.
- `apiEnv`: port, DB, session/auth, allowed origins, public URLs, queue producer config.
- `workerEnv`: DB, queue consumer, storage, selected AI provider, concurrency, sandbox limits.

Production validation is strict per entrypoint. Local build/test does not require production
secrets. Config errors redact values.

## Deployment baseline

One versioned image may expose commands:

```text
node dist/bootstrap/api.js
node dist/bootstrap/worker.js
```

Initial topology may run both on one VPS with managed/external PostgreSQL/storage or Docker
Compose, subject to backup and failure-domain review. Scale worker independently before
considering microservices.

## Microservice extraction triggers

Extraction is considered only if one is measured:

- independent team ownership/release cadence;
- sustained worker resource isolation cannot be achieved by process/container limits;
- database/resource contention requires a separate data boundary;
- compliance requires isolation;
- deployment/reliability data shows the monolith blocks objectives.

“The folder is large” is not a trigger.
