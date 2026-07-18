# Environment and Runtime Configuration

## Environments

| Environment | Purpose | Data | External side effects |
| --- | --- | --- | --- |
| local | developer/agent work | synthetic | disabled/sandbox |
| test | unit/integration/CI | ephemeral synthetic | mocked/captured |
| preview | PR UI/contract preview | synthetic seed | disabled/sandbox |
| staging | release candidate/pilot rehearsal | synthetic or approved staging | sandbox/test accounts |
| production | approved users | production | live approved providers |

Never use production DB/object/provider credentials in local, CI, or preview.

## Process boundaries

`Backend-Lembar` has API and worker entrypoints. Each validates only its own requirements.

### Shared/base

- `NODE_ENV`
- `APP_ENV`
- `SERVICE_NAME`
- `SERVICE_VERSION`/build SHA from deployment
- `LOG_LEVEL`
- `DATABASE_URL` if process uses DB

### API

- `API_PORT`
- `PUBLIC_APP_URL`
- `API_PUBLIC_URL`
- `CORS_ALLOWED_ORIGINS`
- auth/session config selected by D-002
- queue producer config selected by D-004
- optional billing webhook secrets only when module enabled

### Worker

- `WORKER_CONCURRENCY`
- queue consumer config
- object storage config when source/export enabled
- AI provider/model config when generation enabled
- renderer/browser paths/limits when export enabled
- email provider config when notifications enabled

Frontend has its own schema; only intentionally public values carry public prefix.

## Validation behavior

- Runtime schema parses/coerces once at bootstrap and returns typed config.
- Unknown/unexpected keys may be warned or rejected according to environment.
- Empty string normalizes only where documented.
- URLs/ports/origins constrained; allowed origins are exact, no insecure wildcard with cookies.
- `APP_ENV=production` enables strict production requirements; build/test does not require live
  secrets merely because framework sets `NODE_ENV=production`.
- Feature-disabled module does not require its provider secret.
- Error lists missing key names but never values.

## Secret classification and logging

Always secret:

- DB/password-containing URLs;
- auth/session/CSRF signing/encryption keys;
- AI, email, payment, storage keys;
- webhook secrets;
- private keys/cert material;
- signed upload/download/share tokens.

Redaction matches exact keys and value patterns/URLs. Do not log a full config object. Log only
allowlisted safe fields such as app env, service version, port, enabled adapter names, and
concurrency.

## Source of config

- `.env.example` is documentation with safe placeholders.
- `.env`, `.env.local`, tool credential files are ignored.
- Production secrets come from chosen secret/deployment system, not committed files.
- Rotation process records owner, affected runtime, dual-key/rollout if supported, and revoke.
- No secret is sent through agent prompt or task handoff.

## Feature/provider adapters

Configuration must not make unaccepted provider usable accidentally. Provider values require:

- accepted decision/ADR;
- module feature flag;
- environment schema;
- health/readiness behavior;
- redaction classification;
- tests with fake value;
- operational owner and rotation.

## Local defaults

Safe defaults allowed for ports, log level, local URLs, disabled providers, and worker
concurrency. Do not provide default auth/payment/AI/storage production secret. Local development
may generate ephemeral/test-only secret through documented tooling.

## Config change checklist

- correct process only;
- schema + type + default/required rules;
- `.env.example` and README;
- secret/public classification;
- validation/redaction tests;
- deployment manifest/secret entry;
- rotation and rollback;
- no production requirement during install/typecheck/unit build.

