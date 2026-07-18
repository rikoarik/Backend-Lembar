# Deployment, Migration, Backup, and Rollback

Hosting vendor/topology remains D-005. This runbook is provider-neutral.

## Deployable units

- `Frontend-Lembar` web artifact/service.
- `Backend-Lembar` API command.
- `Backend-Lembar` worker command from same source/release version.
- PostgreSQL.
- Queue adapter dependency selected by D-004.
- Private object storage selected by D-006.

API and worker are separate processes/containers for isolation and scaling, not microservices.

## Environment promotion

```text
local/test -> preview -> staging -> production
```

Production release uses immutable artifact/image built once, not rebuild with different code.
Secrets/config are injected per environment. Staging exercises migrations, queue, storage,
provider sandbox, and PDF runtime close to production.

## Release order across repositories

For compatible additive contract:

1. Backend migration expand.
2. Backend deploy accepting old + new contract.
3. Publish/version OpenAPI + generated client.
4. Frontend updates pinned client and deploys.
5. Observe.
6. Backend cleanup/contract only in later release after old consumer window.

Breaking contract requires explicit version/compatibility plan; never coordinate by timing only.

## Pre-deploy checklist

- accepted task/PR and all CI gates;
- dependency/security/license review proportional to change;
- OpenAPI compatibility and generated client;
- migration plan, lock/time/size analysis, backup/restore point;
- env schema and secret availability by process;
- feature flag and rollback owner;
- runbook/dashboard/alert update;
- AI eval/golden PDF/tenant tests where affected;
- release notes and maintenance communication if needed.

## Database migrations

- Forward-only immutable migration files.
- Expand/contract for zero/minimal downtime.
- Add nullable/default-safe column first; backfill in bounded batches; switch reads/writes; add
  constraints after data valid; remove old later.
- Avoid long table locks and unbounded transactions.
- Migration runner is a single controlled release step, not every replica startup racing.
- Backward code compatibility maintained during rollout.
- Destructive migration requires owner approval, backup evidence, and recovery plan.

Rollback usually rolls code forward/back with compatible schema; do not reverse a destructive
migration blindly.

## Deployment steps

1. Announce/start change record and verify current health.
2. Snapshot/backup per risk.
3. Run expand migrations and validation.
4. Deploy API canary/one instance; check readiness/synthetic paths.
5. Deploy worker with controlled concurrency; watch jobs/leases.
6. Increase rollout; verify error, latency, queue, cost, data invariants.
7. Deploy frontend after compatible backend contract.
8. Mark release and observe for defined window.

## Rollback triggers

- security/tenant concern;
- data integrity/quota anomaly;
- sustained critical error/latency/job failure;
- auth/checkout/output primary journey broken;
- unexpected provider/cost explosion.

Rollback action may be feature disable, traffic rollback, worker pause, model route rollback,
or application release rollback. Preserve queue/business state and validate idempotency.

## Backup policy

Before production define:

- PostgreSQL automated backup/PITR window, encryption, region, access;
- object versioning/backup consistent with deletion/legal policy;
- configuration/secret recovery without storing plaintext in docs;
- restore owner and target RPO/RTO;
- cost/capacity monitoring.

Backup success notification is not enough. Run restore drill into isolated environment using
approved data handling and validate row counts, tenant boundaries, object checksums, migrations,
and revoked capability tombstones.

## Disaster recovery

- Declare incident and freeze writes if consistency uncertain.
- Select clean recovery point and document potential data window.
- Restore DB/object/queue-derived state according to source of truth.
- Reapply revocation/deletion tombstones after snapshot.
- Rotate credentials if compromise possible.
- Validate synthetic critical journeys and reconciliation before reopen.
- Communicate facts and postmortem.

## VPS constraints

If initial deployment uses one modest VPS:

- reserve memory for OS, DB/queue if colocated, API, worker, and Chromium spikes;
- isolate worker/renderer limits and concurrency;
- do not colocate sole backup with VPS;
- bind internal dependencies privately/firewall;
- use TLS reverse proxy and automated renewal;
- monitor disk/inodes/memory/swap/load;
- provider-managed DB/storage may reduce operational risk but remains owner decision.

One VPS is not permission to omit backups, process isolation, or graceful shutdown.

## Production access

- Least privilege, MFA/SSH key, no shared root credential.
- Audit deploy/admin access.
- Break-glass documented, time-bounded, rotated after use.
- Agent Orchestrator/coding agents do not receive production secrets or deploy permission by
  default.
- Production actions require explicit owner authorization in a dedicated task.

