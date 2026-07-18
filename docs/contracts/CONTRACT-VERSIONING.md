# Cross-Repository Contract Versioning

## Ownership

- `Backend-Lembar` owns executable OpenAPI and server contract tests.
- `Frontend-Lembar` consumes a pinned generated client/artifact.
- This planning pack owns product semantics and baseline, not runtime publication.
- Hand-edited duplicate DTO/types in frontend are prohibited.

## Artifact identity

Published contract includes:

- semantic contract version;
- backend commit SHA/build ID;
- generated timestamp/source path;
- OpenAPI checksum;
- generator name/version/config;
- generated client package/artifact version.

No environment URLs or secrets are embedded as required defaults.

## Change categories

### Additive compatible

- new optional response field;
- new endpoint/operation;
- new optional request field with safe default;
- new error code only where client has unknown fallback;
- expanded enum is treated as potentially breaking for exhaustive clients unless an unknown
  strategy exists.

### Breaking

- remove/rename field/operation;
- required field addition;
- type/format/meaning change;
- enum contraction or unhandled expansion;
- auth/permission/tenant behavior change;
- status/error semantic change;
- pagination/idempotency behavior change.

## Workflow

1. Product/contract proposal identifies FR, consumers, security, migration.
2. Backend updates OpenAPI/examples and contract tests first.
3. CI performs lint/schema and breaking-change check against accepted baseline.
4. Backend implements backward-compatible behavior and publishes artifact.
5. Frontend pins artifact, regenerates through tool, adapts and tests.
6. Integration gate verifies actual deployed versions.
7. Old contract removal only after consumer window/evidence and explicit task.

## Compatibility window

Frontend and backend deploy independently. A release must tolerate at least:

- new backend + previous supported frontend;
- new frontend + currently deployed compatible backend.

Exact support window is set before production. Feature capability/contract version may be
exposed safely so frontend gates new paths without parsing build strings.

## Generated client

- Deterministic generation and lockfile pin.
- Generated directory marked and not manually edited.
- Wrapper may add auth/workspace/request ID/error mapping without redefining DTOs.
- CI fails if generated output differs from pinned source.
- Unknown enum/error has safe UI fallback and telemetry code only.

## Contract test matrix

- schema examples validate;
- required auth/workspace/idempotency headers;
- stable error envelope/codes;
- pagination/cursor;
- source upload intent/complete;
- async job terminal states;
- version conflict;
- final/export/share boundaries;
- cross-tenant unauthorized responses;
- redaction/no secret in examples.

## Emergency change

Security containment may disable a capability immediately. Follow with:

- incident record and feature flag/compatible safe error;
- consumer communication;
- contract/update task;
- restore/removal plan.

Do not silently return a different response shape during emergency.

