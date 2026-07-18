# Backend-Lembar Documentation Pack

Repository purpose: seluruh backend `lembar` dalam satu modular monolith.

## Backend owns

- REST API and executable OpenAPI contract.
- Authentication/session integration and authorization policy.
- Workspace/tenant boundary and role enforcement.
- PostgreSQL schema, migrations, transactions, and audit.
- Source upload/extraction, background jobs, AI, quality checks, and PDF.
- Object storage, quota/entitlement, billing integration, observability, and operations.
- Publishing generated API client/contract artifact for frontend.

## Backend does not own

- Landing visual design and frontend component implementation.
- Client-only state and browser presentation rules.
- Product prices, market claims, curriculum content, or legal decisions without owner approval.
- Mobile implementation.

## Process model

One repository and one backend codebase, with two entrypoints:

- `api`: HTTP/auth/policy/orchestration.
- `worker`: source extraction, AI generation, quality, PDF, notifications, cleanup.

They share domain modules and PostgreSQL. They may run as separate processes/containers for
reliability. This is not microservices.

Only work on an explicitly started backend task ID. Return `READY_FOR_OWNER_REVIEW`, then stop.
