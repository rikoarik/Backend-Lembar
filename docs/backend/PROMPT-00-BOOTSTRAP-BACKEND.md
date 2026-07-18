# Prompt B0-01 — Bootstrap Backend-Lembar

Precondition: D-014, D-016, and D-018 are `Accepted` with the values used below. If not, stop and
return `BLOCKED_BY_DECISION`; do not bootstrap a framework from this proposed prompt.

Paste this prompt only when the owner is ready to start `B0-01`.

```md
START B0-01 — Bootstrap the Backend-Lembar modular-monolith repository foundation.

Project context:

- Product: `lembar`, an AI-assisted assessment production workspace for Indonesian teachers.
- This repository is BACKEND ONLY.
- Frontend lives in the separate `rikoarik/Frontend-Lembar` repository.
- Backend is one TypeScript modular monolith with API and worker entrypoints.
- It is not a microservices project.

Read and follow, in precedence order:

1. AGENTS.md
2. docs/product/PRD.md
3. docs/product/FRD-MVP.md
4. docs/product/BUSINESS-ROLES-PERMISSIONS.md
5. docs/backend/BACKEND-ARCHITECTURE.md
6. docs/contracts/CROSS-REPO-CONTRACT.md
7. exact B0-01 task contract

Outcome:
A clean NestJS + Fastify + TypeScript strict backend repository that boots an API health
endpoint and a worker heartbeat from the same codebase, with reproducible baseline tooling.

Implement only:

- one pnpm package/repository and supported Node LTS pin;
- NestJS with Fastify adapter selected from current stable compatible releases;
- `api` entrypoint serving GET `/health` on local port 4000;
- `worker` entrypoint emitting one structured, secret-free heartbeat and exiting successfully;
- initial module/layout boundaries without fake business implementations;
- strict TypeScript, lint, format, unit/smoke tests, build scripts;
- safe `.gitignore`, `.editorconfig`, `.env.example`, and concise README;
- CI baseline if the exact B0-01 contract includes it.

Do not implement:

- database schema/ORM, auth, queue/Redis, AI/OpenAI calls, S3, PDF, billing, curriculum data;
- frontend or Next.js;
- microservices, internal HTTP, Docker production topology;
- Gemini, 9Router, Realtime API, or provider skills;
- B0-02 or any later task.

Rules:

- Inspect repository before editing and preserve owner work.
- Use official current framework docs for version-sensitive setup.
- Do not require production secrets for install/build/test.
- Do not resolve D-002/D-003/D-004 implicitly; their spikes are separate tasks.
- Keep exactly B0-01 in progress.

Acceptance evidence must include exact commands for install, typecheck, lint, format check,
tests, build, secret scan, GET /health response, and worker heartbeat/exit.

Return the standard handoff with status READY_FOR_OWNER_REVIEW, then STOP. Do not start B0-02.
```
