# PDF Export Architecture and Security

User-visible layout is defined in `frontend/PRINT-PDF-SPEC.md`. Backend owns the canonical
final artifact lifecycle.

## Preconditions

- Only an authorized final assessment version can produce final artifact.
- Requested package options are validated against entitlement and share scope.
- Input print model is immutable and versioned.
- D-020 HTML/CSS + Playwright/Chromium must be Accepted after PoC before production build.

## Artifact key

Deterministic identity includes:

```text
workspace_id
assessment_version_id
print_model_schema_version
renderer_version
template_version
font_bundle_version
output_options_hash
locale
```

Matching authorized artifact may be reused. Changing any content/layout option creates a new
artifact; it never overwrites another immutable version.

## Pipeline

1. API validates permission/final state and creates idempotent export job.
2. Worker builds a minimal `PrintDocument` DTO from authorized domain data.
3. Template renders static HTML with escaped content and local versioned assets.
4. Renderer loads HTML in isolated Chromium context with network disabled by default.
5. Wait for explicit render-ready signal and font completion; use hard timeout.
6. Generate A4 PDF with tested margin/background/header settings.
7. Validate magic bytes, nonzero/page count, maximum size, and optional text/glyph checks.
8. Compute checksum; store private object with safe metadata.
9. Persist artifact/result atomically; emit event; commit/release quota policy if any.

## PrintDocument boundary

DTO contains only fields needed for selected output:

- safe assessment header metadata;
- ordered passages/questions/options;
- package-specific answers/explanations;
- authorized logo/image asset references transformed to trusted internal bytes;
- version/footer fields.

It must not contain account email, source storage key, signed URL, provider/prompt metadata,
audit notes, hidden teacher content for student-only package, or arbitrary HTML.

## Template safety

- Escape all user/generated strings.
- No `dangerouslySetInnerHTML`/raw HTML from source or model.
- Sanitize any explicitly supported rich text to an allowlist before print DTO.
- No external scripts/styles/fonts/images.
- Block `http`, `https`, `file`, data exfiltration, and unknown URL schemes in browser context.
- Disable JavaScript except minimal trusted render-ready code where required.
- CSP defense-in-depth and request interception abort all unexpected requests.
- Images fetched/validated by backend and supplied from trusted local/internal source.

## Chromium isolation

- Dedicated non-root worker/container where feasible.
- Current patched browser runtime and pinned image.
- CPU/memory/time/page/file limits.
- Incognito context per job; no shared cookies/cache.
- No application/session credentials in browser.
- Temp directory unique and deleted after result/failure.
- Browser process recycled by bounded policy without sharing page state.

## Storage and access

- Private bucket/container; no public ACL.
- Object key is random/opaque and not logged at info level.
- Server authorizes artifact before issuing short-lived download intent.
- Content-Disposition uses sanitized filename and RFC-safe fallback.
- Correct `application/pdf`, `nosniff`, cache policy, and anti-index headers.
- Share link endpoint issues only package allowed by share scope.
- Revocation blocks new access; signed URL lifetime remains intentionally short.

## Direct print

Frontend opens the canonical artifact/viewer. Backend does not create a separate “print PDF.”
Artifact version/hash is returned so UI can show exact final version.

## Failure handling

- Render timeout/browser crash/storage transient: bounded retry.
- Invalid template/input/missing glyph/oversize: terminal failure for version with diagnostic
  code and alert to owners.
- Existing final assessment remains unchanged.
- Partial/corrupt object is never marked ready and is deleted/quarantined.
- Retry with same artifact key does not create duplicate visible artifacts.

## Observability

Record without content:

- job/artifact/assessment version IDs;
- renderer/template/font versions;
- page count, byte size, duration, memory class;
- success/failure code and retry count;
- checksum prefix only where operationally safe.

No question text, filename, school name, signed URL, raw HTML, or PDF bytes in logs/traces.

## PoC acceptance D-020

- golden fixtures from print spec render correctly;
- A4 physical dimensions/page breaks verified;
- Indonesian glyph/font embedding verified;
- network egress test proves external requests blocked;
- malicious HTML/source strings remain text;
- memory/latency under representative 20/50-question packages measured;
- deterministic artifact/page count for same input/runtime;
- print and download verified as same artifact;
- container/VPS footprint acceptable to owner.

