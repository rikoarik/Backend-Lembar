# Domain & Data Model

This is a logical model. Physical table/index choices follow ORM/query decision and workload
evidence. Every tenant-bound unique constraint includes workspace scope where appropriate.

## Identity and tenancy

### Account

- `id`, display name, normalized identifiers, status, timestamps.
- Auth credential/session tables follow the accepted auth provider/library.

### Workspace

- `id`, `type: personal|school`, name, status, locale/timezone, branding config, timestamps.

### Membership

- `account_id`, `workspace_id`, role, status, joined/disabled timestamps.
- Unique account + workspace.
- Role changes audited.

### Invitation

- workspace, intended role, hashed single-use token, expiry, accepted/revoked state.

## Catalog

### CurriculumVersion

- name/code/version/source URL/source document/effective dates/status/published metadata.
- Published record immutable; corrections create a new version.

### Grade, Subject, CurriculumOutcome, Material

- Normalized catalog entities with version relation and status.
- Material may represent approved catalog metadata/content references, not pirated book files.

## Sources

### Source

- workspace, owner, type, original metadata, status, object key, checksum, size, page count,
  retention/deletion timestamps.

### SourceVersion / Passage

- Extraction version, parser version, page/section locator, normalized text, hash.
- Passage never loses linkage to source version.

## Assessment aggregate

### Assessment

- workspace, creator, title, status, current draft version, current final version, timestamps.

### AssessmentVersion

- immutable snapshot number/status/config/curriculum version/prompt schema version.
- Draft editing uses optimistic revision; final is immutable.

### BlueprintItem

- assessment version, sequence, outcome/indicator, topic, difficulty, cognitive target,
  question type, source constraints.

### Question

- version, blueprint item, sequence, type, stem, structured options, answer key, explanation,
  difficulty, review state, quality state.

### QuestionSourceReference

- question, source version, locator/passage, support type, optional confidence/internal evidence.

### ReviewAction

- actor, question/version, action, reason, before/after-safe diff reference, timestamp.
- Avoid storing excessive duplicated sensitive text in general audit logs.

## Jobs and idempotency

### Job

- workspace, kind, status, stage, attempt, input reference, progress, failure code,
  timestamps, lease/heartbeat.

### IdempotencyRecord

- scope, key hash, request fingerprint, response/resource reference, expiry.

### OutboxEvent

- aggregate/type/payload version/status/attempt. Written in the same transaction as state change.

## Output

### ExportArtifact

- final version, format, template version, checksum, object key, status, size, expiry/retention.

### ShareLink

- final version, hashed token, visibility options, expiry, revoked timestamp, access counters.

Never store plaintext share token after creation when hash verification is sufficient.

## Library

### QuestionBankEntry

- workspace, owner/scope, source question/version, tags, status.
- Default scope private. Moving/copying to school bank requires explicit action and permission.

### GenerationTemplate

- workspace/owner/name/version/config references/status.
- Revalidation required when catalog/source changes.

## Commerce

### Plan / Entitlement

- versioned feature and limit configuration.

### Subscription

- workspace, provider reference, plan version, status, billing period.

### QuotaLedger

- workspace/account attribution, operation, units, state, idempotency reference, reason,
  resulting balance/snapshot strategy.
- Append-only financial-style record; corrections are new entries.

## Operations

### AuditEvent

- actor type/id, workspace, action, target type/id, reason, request ID, safe metadata, timestamp.

### FeatureFlag / PromptVersion / ModelRoute

- Versioned configuration, environment, rollout, owner, audit.
- No secret material stored in normal configuration tables.

## Marketing content

### MarketingPage

- Platform-global slug + locale identity and pointer to current published version.
- Unique (slug, locale). It is not tenant-bound and never accepts workspace scope as
  authorization.

### MarketingPageVersion

- Page, monotonically increasing version, schema version, state, revision.
- Structured content JSON, SEO JSON, creator/publisher timestamps and actor references.
- Published version is immutable; restore creates a new draft.

### MarketingGlobalSet / MarketingGlobalVersion

- Versioned navigation, footer, global CTA registry, and default SEO.
- Uses the same draft/publish/restore rules as pages.

### MarketingMediaAsset

- Metadata/reference only; publication requires ready/approved state.
- Binary storage reuses the approved storage facility if/when media upload is implemented.

## High-risk invariants

- No tenant-bound repository method without workspace context.
- Final version cannot be mutated.
- Published curriculum version cannot be edited in place.
- Published marketing page/global version cannot be edited in place.
- Public marketing reads can never resolve a draft version.
- Quota commit cannot exceed reservation without explicit adjustment.
- Job terminal state cannot transition back except controlled replay/new job.
- Share token access does not expose key/pembahasan unless explicitly configured.
- Deleting source does not silently corrupt an existing final version; retention/legal policy
  defines what evidence snapshot remains.

## Index/constraint baseline

- Membership `(workspace_id, account_id)` unique.
- Assessment history `(workspace_id, updated_at, id)`.
- Job claim/status indexes.
- Idempotency scope + key hash unique.
- Source checksum scoped appropriately.
- Share token hash unique.
- Foreign keys and check constraints for critical state/units.
- Full-text/vector indexes only after query/eval benchmark.
