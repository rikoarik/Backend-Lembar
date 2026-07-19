# ADR Note — B0-07 Storage + PDF Spike Boundary

Status: Spike only (not accepted architecture)

## Scope of this spike

B0-07 scaffolds two reversible backend seams without selecting the production providers:

- `src/infrastructure/storage/StorageAdapter.ts`
  - `InMemoryAdapter`
  - `LocalFilesystemAdapter`
  - `STORAGE_DRIVER=memory|local`
- `src/infrastructure/pdf/RenderAdapter.ts`
  - `StubHtmlToPdfAdapter`
  - disabled `PlaywrightHtmlToPdfAdapter`
  - `PDF_RENDERER_DRIVER=stub|playwright`

The implementations are intentionally local-only and deterministic so later tasks can verify behavior
without installing paid SDKs, Playwright, Chromium, or cloud storage.

## Explicitly not decided here

### D-006 object storage

Open questions for owner:

1. Which private object store is accepted for production (S3-compatible, GCS, Cloudflare R2, etc.)?
2. Where should short-lived signed download URLs terminate: direct object-store URL or backend proxy?
3. What metadata policy is required on stored artifacts (checksum, tenant, retention, lifecycle class)?
4. What is the accepted max signed URL lifetime for final artifacts?

### D-020 PDF renderer

Open questions for owner:

1. Is Playwright/Chromium accepted after the PoC, or should another renderer be evaluated?
2. What runtime isolation/container policy is required for Chromium if accepted?
3. Which golden fixtures are canonical for A4 acceptance beyond the single spike fixture?
4. What non-functional thresholds matter for acceptance (latency, memory, page-count determinism)?

## Reversible local assumptions

- Signed URLs are treated as secrets and never logged.
- Storage keys are treated as secrets and never logged.
- Stub PDF output is deterministic bytes derived from `sha256(html + options)` semantics, not a real PDF.
- Local filesystem storage exists only to exercise the adapter seam and smoke flow.

## Exit criteria for replacing this spike

Replace the spike when D-006 and D-020 are accepted and a production task is authorized to:

- swap `StorageAdapter` to the accepted private provider;
- implement `PlaywrightHtmlToPdfAdapter` (or alternative) with network isolation and A4 fixture coverage;
- preserve the current redaction, expiry, and deterministic-fixture tests where still applicable.
